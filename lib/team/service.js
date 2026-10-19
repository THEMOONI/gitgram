const fs = require('fs');
const path = require('path');
const { nowIso } = require('./schema');
const { sha256 } = require('./secret');
const { agentShouldRespond, canSpend, utcDay } = require('./policy');
const { normalizeTags, assessLegal, suggestRisks, mergeRisks, lawyerBadge } = require('./legal');
const { readDocument, readPastedContract, storeDocument } = require('./documents');
const { safeHttpUrl } = require('./urls');
const { createTradingAlerts } = require('./trading/store');
const { planAgentDisclosure, TRADING_REMINDER } = require('./ai-disclosure');

function fail(status, error) {
  return { ok: false, status, error };
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function displayTime(iso) {
  return String(iso || '').replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '').slice(0, 16);
}

function clampInt(value, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function clampUsage(usage) {
  return {
    tokens: clampInt(usage?.tokens, 1, 1_000_000),
    costCents: clampInt(usage?.costCents ?? usage?.cost_cents, 0, 1_000_000),
  };
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function cleanRoomName(name) {
  if (typeof name !== 'string') return '';
  const cleaned = name.replace(/[\u0000-\u001F]/g, '').trim().replace(/\s+/g, ' ');
  if (cleaned.length < 2 || cleaned.length > 60) return '';
  return cleaned;
}

function createTeamService(db, options) {
  const config = options.config;
  const dataDir = options.dataDir;
  const maxHops = options.maxHops;
  const hub = options.hub;
  const ledger = options.ledger;
  const sessions = options.sessions || new Map();
  const ownerUsername = typeof options.ownerUsername === 'string' ? options.ownerUsername : '';
  const trading = createTradingAlerts(db, {
    hub,
    config,
    now: options.now,
    excludeFile: options.excludeFile || '',
    minLiquidityUsd: options.minLiquidityUsd,
    limiter: options.tradingLimiter,
    quietHours: options.quietHours,
    watcherState: options.watcherState,
  });

  function publish(roomSlug, event) {
    if (hub) hub.broadcast(roomSlug, event);
  }

  function noteSession(userId, sessionId) {
    if (!userId || !sessionId) return;
    sessions.set(Number(userId), String(sessionId));
  }

  function sessionFor(userId) {
    return sessions.get(Number(userId)) || '';
  }

  function audienceUserId(parent) {
    let current = parent;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.author_type === 'user' && current.user_id) return current.user_id;
      if (!current.parent_id) break;
      current = loadMessageRow(current.parent_id);
    }
    return null;
  }

  function agentByToken(token) {
    if (!token) return null;
    return db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(sha256(token)) || null;
  }

  function getUsage(agentId) {
    const row = db.prepare('SELECT tokens, cost_cents FROM agent_usage WHERE agent_id = ? AND day = ?').get(agentId, utcDay());
    return row || { tokens: 0, cost_cents: 0 };
  }

  function addUsage(agentId, usage) {
    db.prepare(`
      INSERT INTO agent_usage (agent_id, day, tokens, cost_cents) VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, day) DO UPDATE SET
        tokens = tokens + excluded.tokens,
        cost_cents = cost_cents + excluded.cost_cents
    `).run(agentId, utcDay(), usage.tokens, usage.costCents);
  }

  function membership(roomId, userId) {
    return db.prepare(
      'SELECT role FROM room_members WHERE room_id = ? AND user_id = ?',
    ).get(roomId, userId) || null;
  }

  function ensureUserLobby(userId) {
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    const channels = db.prepare(
      "SELECT id, visibility FROM rooms WHERE visibility IN ('channel', 'owner') ORDER BY id",
    ).all();
    const insert = db.prepare(`
      INSERT INTO room_members (room_id, member_type, user_id, role, created_at)
      VALUES (?, 'user', ?, ?, ?)
    `);
    const remove = db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?');
    for (const room of channels) {
      if (room.visibility === 'owner') {
        const allowed = Boolean(ownerUsername) && user && user.username === ownerUsername;
        if (!allowed) {
          remove.run(room.id, userId);
          continue;
        }
      }
      const existing = membership(room.id, userId);
      if (existing) continue;
      const owner = db.prepare(
        "SELECT id FROM room_members WHERE room_id = ? AND member_type = 'user' AND role = 'owner'",
      ).get(room.id);
      insert.run(room.id, userId, owner ? 'member' : 'owner', nowIso());
    }
  }

  function listRooms(userId) {
    return db.prepare(`
      SELECT r.id, r.slug, r.name, r.visibility, m.role
      FROM rooms r
      JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
      ORDER BY r.id
    `).all(userId);
  }

  function getRoomBySlug(slug) {
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) return null;
    return db.prepare('SELECT * FROM rooms WHERE slug = ?').get(slug) || null;
  }

  function requireUserRoom(slug, userId) {
    const room = getRoomBySlug(slug);
    if (!room) return fail(404, 'not_found');
    const member = membership(room.id, userId);
    if (!member) return fail(403, 'forbidden');
    return { ok: true, room, role: member.role };
  }

  function requireAgentRoom(slug, agent) {
    const room = getRoomBySlug(slug);
    if (!room) return fail(404, 'not_found');
    const member = db.prepare(
      'SELECT role FROM room_members WHERE room_id = ? AND agent_id = ?',
    ).get(room.id, agent.id);
    if (!member) return fail(403, 'forbidden');
    return { ok: true, room, role: member.role };
  }

  function listAgentRooms(agentId) {
    return db.prepare(`
      SELECT r.id, r.slug, r.name
      FROM rooms r
      JOIN room_members m ON m.room_id = r.id AND m.agent_id = ?
      ORDER BY r.id
    `).all(agentId);
  }

  function createRoom(userId, name) {
    const cleaned = cleanRoomName(name);
    const base = slugify(cleaned);
    if (!cleaned || base.length < 2) return fail(400, 'name');
    let slug = base;
    let n = 2;
    while (db.prepare('SELECT id FROM rooms WHERE slug = ?').get(slug)) {
      slug = `${base.slice(0, 36)}-${n}`;
      n += 1;
      if (n > 50) return fail(409, 'name');
    }
    const created = nowIso();
    const roomId = db.transaction(() => {
      const info = db.prepare(
        'INSERT INTO rooms (slug, name, visibility, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(slug, cleaned, 'private', userId, created);
      const id = Number(info.lastInsertRowid);
      db.prepare(
        "INSERT INTO room_members (room_id, member_type, user_id, role, created_at) VALUES (?, 'user', ?, 'owner', ?)",
      ).run(id, userId, created);
      const agents = db.prepare('SELECT id FROM agents').all();
      const add = db.prepare(
        "INSERT INTO room_members (room_id, member_type, agent_id, role, created_at) VALUES (?, 'agent', ?, 'member', ?)",
      );
      for (const agent of agents) add.run(id, agent.id, created);
      return { id, agentIds: agents.map((agent) => agent.id) };
    })();
    if (hub && hub.addAgents) hub.addAgents(slug, roomId.agentIds);
    return { ok: true, status: 201, room: db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId.id) };
  }

  function addMember(actorId, slug, username) {
    const access = requireUserRoom(slug, actorId);
    if (!access.ok) return access;
    if (access.room.visibility === 'owner') return fail(403, 'forbidden');
    if (access.role !== 'owner') return fail(403, 'forbidden');
    if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{3,39}$/.test(username)) return fail(400, 'username');
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!user) return fail(404, 'not_found');
    if (membership(access.room.id, user.id)) return { ok: true, status: 200 };
    db.prepare(
      "INSERT INTO room_members (room_id, member_type, user_id, role, created_at) VALUES (?, 'user', ?, 'member', ?)",
    ).run(access.room.id, user.id, nowIso());
    return { ok: true, status: 201 };
  }

  function listMembers(roomId) {
    return db.prepare(`
      SELECT rm.role, rm.member_type, rm.user_id, rm.agent_id,
             u.username, a.slug AS agent_slug, a.name AS agent_name, a.role AS agent_role,
             a.panel, a.disclaimer
      FROM room_members rm
      LEFT JOIN users u ON u.id = rm.user_id
      LEFT JOIN agents a ON a.id = rm.agent_id
      WHERE rm.room_id = ?
      ORDER BY CASE rm.member_type WHEN 'user' THEN 0 ELSE 1 END, COALESCE(u.username, a.slug)
    `).all(roomId).map((row) => ({
      type: row.member_type,
      role: row.role,
      userId: row.user_id,
      agentId: row.agent_id,
      name: row.member_type === 'user' ? row.username : row.agent_name,
      slug: row.agent_slug || '',
      agentRole: row.agent_role || '',
      panel: row.panel || 'human',
      disclaimer: row.disclaimer || '',
    }));
  }

  function documentsByMessage(messageIds) {
    if (!messageIds.length) return new Map();
    const marks = messageIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM documents WHERE message_id IN (${marks}) ORDER BY id`,
    ).all(...messageIds);
    const grouped = new Map();
    for (const row of rows) {
      const list = grouped.get(row.message_id) || [];
      list.push(row);
      grouped.set(row.message_id, list);
    }
    return grouped;
  }

  function presentMessage(row, documents = []) {
    const authorType = row.author_type;
    const authorName = authorType === 'user'
      ? (row.username || 'User')
      : authorType === 'agent'
        ? (row.agent_name || 'Agent')
        : 'System';
    return {
      id: row.id,
      kind: 'message',
      roomId: row.room_id,
      body: row.body,
      authorType,
      authorName,
      agentId: row.agent_id,
      agentSlug: row.agent_slug || '',
      userId: row.user_id,
      panel: authorType === 'agent' ? (row.panel || 'standard') : authorType === 'user' ? 'human' : 'system',
      hop: row.hop,
      parentId: row.parent_id,
      addressedAgentId: row.addressed_agent_id,
      legalTags: parseJson(row.legal_tags, []),
      risks: parseJson(row.risks, []),
      badges: parseJson(row.badges, []),
      disclaimer: row.disclaimer || '',
      needsLawyer: Boolean(row.needs_lawyer),
      aiGenerated: Boolean(row.ai_generated),
      aiReminder: authorType === 'agent' && (row.panel === 'demo' || row.agent_slug === 'trading')
        ? TRADING_REMINDER
        : '',
      createdAt: row.created_at,
      displayTime: displayTime(row.created_at),
      documents: documents.map((doc) => ({
        id: doc.id,
        name: doc.original_name,
        preview: String(doc.extracted_text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      })),
    };
  }

  function loadMessageRow(id) {
    return db.prepare(`
      SELECT m.*, u.username, a.slug AS agent_slug, a.name AS agent_name, a.panel
      FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.id = ?
    `).get(id);
  }

  function presentStoredMessage(id) {
    const row = loadMessageRow(id);
    if (!row) return null;
    const docs = documentsByMessage([id]).get(id) || [];
    return presentMessage(row, docs);
  }

  function listMessageRows(roomId) {
    return db.prepare(`
      SELECT m.*, u.username, a.slug AS agent_slug, a.name AS agent_name, a.panel
      FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.room_id = ?
      ORDER BY m.id ASC
      LIMIT 200
    `).all(roomId);
  }

  function presentFlag(row, acknowledgements) {
    const projects = parseJson(row.affected_projects, []);
    const agents = parseJson(row.affected_agents, []);
    const needsLawyer = Boolean(row.needs_lawyer);
    const badge = config.legal.needsLawyerBadge;
    return {
      id: row.id,
      kind: 'flag',
      kindLabel: config.legal.flagKindLabel,
      title: row.title,
      severity: row.severity,
      summary: row.summary,
      affectedProjects: projects,
      affectedAgents: agents,
      recommendedAction: row.recommended_action,
      needsLawyer,
      needsLawyerText: `${badge}: ${needsLawyer ? config.legal.flagYes : config.legal.flagNo}`,
      sourceUrl: row.source_url,
      safeUrl: safeHttpUrl(row.source_url),
      createdAt: row.created_at,
      displayTime: displayTime(row.created_at),
      acknowledgements: acknowledgements.map((ack) => ({
        username: ack.username,
        createdAt: ack.created_at,
        displayTime: displayTime(ack.created_at),
      })),
    };
  }

  function flagsForRooms(roomIds) {
    if (!roomIds.length) return [];
    const marks = roomIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT DISTINCT f.*
      FROM regulatory_flags f
      JOIN flag_rooms fr ON fr.flag_id = f.id
      WHERE fr.room_id IN (${marks})
      ORDER BY f.id ASC
    `).all(...roomIds);
    return hydrateFlags(rows);
  }

  function hydrateFlags(rows) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => '?').join(',');
    const acks = db.prepare(`
      SELECT fa.flag_id, fa.created_at, u.username
      FROM flag_acknowledgements fa
      JOIN users u ON u.id = fa.user_id
      WHERE fa.flag_id IN (${marks})
      ORDER BY fa.id
    `).all(...ids);
    const byFlag = new Map();
    for (const ack of acks) {
      const list = byFlag.get(ack.flag_id) || [];
      list.push(ack);
      byFlag.set(ack.flag_id, list);
    }
    return rows.map((row) => presentFlag(row, byFlag.get(row.id) || []));
  }

  function flagVisible(flag, filters) {
    if (filters.severity && flag.severity !== filters.severity) return false;
    if (filters.project) {
      const needle = filters.project.toLowerCase();
      if (!flag.affectedProjects.some((project) => project.toLowerCase().includes(needle))) return false;
    }
    if (filters.ack === 'open' && flag.acknowledgements.length) return false;
    if (filters.ack === 'done' && !flag.acknowledgements.length) return false;
    return true;
  }

  function listTimeline(room, filters) {
    const rows = listMessageRows(room.id);
    const docs = documentsByMessage(rows.map((row) => row.id));
    const messages = rows.map((row) => presentMessage(row, docs.get(row.id) || []));
    const flags = flagsForRooms([room.id]).filter((flag) => flagVisible(flag, filters));
    const alerts = trading.listVisible(room.id, filters);
    const items = [...messages, ...flags, ...alerts].sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.id - b.id;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    const ownerRoom = room.visibility === 'owner';
    const notices = ownerRoom ? trading.listNotices() : { items: [], digest: '', digestSound: false };
    return {
      messages,
      flags,
      alerts,
      items,
      notices,
      watcherOffline: ownerRoom ? trading.isSilent() : false,
    };
  }

  function listPendingApprovals(roomId) {
    return db.prepare(`
      SELECT ta.*, a.name AS agent_name, a.slug AS agent_slug
      FROM tool_approvals ta
      JOIN agents a ON a.id = ta.agent_id
      WHERE ta.room_id = ? AND ta.status = 'pending'
      ORDER BY ta.id
    `).all(roomId).map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      toolName: row.tool_name,
      toolInput: row.tool_input,
      agentName: row.agent_name,
      agentSlug: row.agent_slug,
      createdAt: row.created_at,
      displayTime: displayTime(row.created_at),
    }));
  }

  function insertMessage(fields) {
    const info = db.prepare(`
      INSERT INTO messages (
        room_id, author_type, user_id, agent_id, body, hop, parent_id, addressed_agent_id,
        legal_tags, risks, badges, disclaimer, needs_lawyer, ai_generated, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fields.roomId,
      fields.authorType,
      fields.userId || null,
      fields.agentId || null,
      fields.body,
      fields.hop || 0,
      fields.parentId || null,
      fields.addressedAgentId || null,
      JSON.stringify(fields.legalTags || []),
      JSON.stringify(fields.risks || []),
      JSON.stringify(fields.badges || []),
      fields.disclaimer || '',
      fields.needsLawyer ? 1 : 0,
      fields.aiGenerated ? 1 : 0,
      fields.createdAt || nowIso(),
    );
    return Number(info.lastInsertRowid);
  }

  function attachDocuments(roomId, messageId, userId, documents) {
    const written = [];
    const insert = db.prepare(`
      INSERT INTO documents (
        room_id, message_id, uploaded_by, original_name, stored_path, mime, byte_size, extracted_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      for (const document of documents) {
        const stored = storeDocument(dataDir, roomId, document);
        written.push(path.join(dataDir, stored));
        insert.run(
          roomId,
          messageId,
          userId,
          document.originalName,
          stored,
          document.mime,
          document.buffer.length,
          document.text,
          nowIso(),
        );
      }
    } catch (error) {
      for (const file of written) {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      }
      throw error;
    }
  }

  function postUserMessage(userId, slug, input) {
    if (input.sessionId) noteSession(userId, input.sessionId);
    const access = requireUserRoom(slug, userId);
    if (!access.ok) return access;
    const tags = normalizeTags(input.legalTags, config);
    if (!tags.ok) return fail(400, 'tags');
    const documents = [];
    if (input.file) {
      const read = readDocument(input.file, config);
      if (!read.ok) return fail(400, read.error);
      documents.push(read.document);
    }
    if (input.contractText) {
      const pasted = readPastedContract(input.contractText, config);
      if (pasted && !pasted.ok) return fail(400, pasted.error);
      if (pasted) documents.push(pasted.document);
    }
    let body = typeof input.body === 'string' ? input.body.replace(/\u0000/g, '').trim() : '';
    if (body.length > config.messageMaxChars) return fail(400, 'message');
    if (!body && documents.length) body = 'Attached a document for review.';
    if (!body) return fail(400, 'message');
    let addressed = null;
    if (input.addressedAgentId != null && input.addressedAgentId !== '') {
      addressed = Number(input.addressedAgentId);
      if (!Number.isInteger(addressed)) return fail(400, 'agent');
      const agent = db.prepare(
        'SELECT a.id FROM agents a JOIN room_members m ON m.agent_id = a.id WHERE a.id = ? AND m.room_id = ?',
      ).get(addressed, access.room.id);
      if (!agent) return fail(400, 'agent');
    }
    const messageId = db.transaction(() => {
      const id = insertMessage({
        roomId: access.room.id,
        authorType: 'user',
        userId,
        body,
        hop: 0,
        addressedAgentId: addressed,
        legalTags: tags.tags,
      });
      if (documents.length) attachDocuments(access.room.id, id, userId, documents);
      return id;
    })();
    const message = presentStoredMessage(messageId);
    publish(access.room.slug, { type: 'message', room: access.room.slug, message });
    return { ok: true, status: 201, message };
  }

  function capNotice(agent, room) {
    const body = `${agent.name} has hit the daily cap and stayed quiet.`;
    const existing = db.prepare(`
      SELECT id FROM messages
      WHERE room_id = ? AND author_type = 'system' AND body = ? AND created_at >= ?
    `).get(room.id, body, utcDay());
    if (existing) return presentStoredMessage(existing.id);
    const id = insertMessage({ roomId: room.id, authorType: 'system', body, hop: 0 });
    const message = presentStoredMessage(id);
    publish(room.slug, { type: 'message', room: room.slug, message });
    return message;
  }

  function sourceText(parent, documents, recent, replyBody) {
    return [
      parent?.body || '',
      replyBody || '',
      ...documents.map((doc) => doc.extracted_text || doc.text || ''),
      ...recent.map((item) => item.body || ''),
    ].join('\n');
  }

  function postAgentMessage(agent, slug, input) {
    const access = requireAgentRoom(slug, agent);
    if (!access.ok) return access;
    const parent = input.parentId ? loadMessageRow(input.parentId) : null;
    if (!parent || parent.room_id !== access.room.id) return fail(400, 'bad_parent');
    const decision = agentShouldRespond(agent, parent, { maxHops });
    if (!decision.respond) return fail(403, decision.reason);
    const duplicate = db.prepare(
      "SELECT id FROM messages WHERE parent_id = ? AND agent_id = ? AND author_type = 'agent'",
    ).get(parent.id, agent.id);
    if (duplicate) return fail(409, 'already_replied');
    const spend = clampUsage(input.usage);
    const usage = getUsage(agent.id);
    if (!canSpend(agent, usage, spend).ok) {
      capNotice(agent, access.room);
      return fail(429, 'daily_cap');
    }
    let body = typeof input.body === 'string' ? input.body.replace(/\u0000/g, '').trim() : '';
    if (!body || body.length > config.messageMaxChars) return fail(400, 'message');
    const humanId = audienceUserId(parent);
    const sessionId = input.sessionId || sessionFor(humanId) || (humanId ? `user:${humanId}` : `room:${access.room.id}`);
    const planned = ledger
      ? planAgentDisclosure({
        ledger,
        sessionId,
        agentKey: agent.slug,
        agentName: agent.name,
        body,
        parentBody: parent.body,
      })
      : { text: body, pending: false, line: '' };
    body = planned.text.length > config.messageMaxChars + 600
      ? planned.text.slice(0, config.messageMaxChars + 600)
      : planned.text;
    const recent = db.prepare(`
      SELECT body FROM messages WHERE room_id = ? AND id <= ? ORDER BY id DESC LIMIT ?
    `).all(access.room.id, parent.id, config.contextMessages);
    const docRows = documentsByMessage([parent.id]).get(parent.id) || [];
    const blob = sourceText(parent, docRows, recent, body);
    let legalTags = [];
    let risks = [];
    let badges = [];
    let disclaimer = '';
    let needsLawyer = false;
    if (agent.panel === 'legal') {
      const parentTags = parseJson(parent.legal_tags, []);
      const supplied = normalizeTags(input.legalTags, config);
      legalTags = parentTags.length ? parentTags : (supplied.ok && supplied.tags.length ? supplied.tags : ['General law']);
      risks = mergeRisks(suggestRisks(blob, config), input.risks);
      needsLawyer = Boolean(input.needsLawyer) || assessLegal(blob, config).needsLawyer;
      disclaimer = agent.disclaimer || '';
      if (needsLawyer) badges = [lawyerBadge(config)];
    } else if (agent.panel === 'demo') {
      disclaimer = agent.disclaimer || '';
    }
    let message;
    try {
      const messageId = insertMessage({
        roomId: access.room.id,
        authorType: 'agent',
        agentId: agent.id,
        body,
        hop: decision.hop,
        parentId: parent.id,
        legalTags,
        risks,
        badges,
        disclaimer,
        needsLawyer,
        aiGenerated: true,
      });
      addUsage(agent.id, spend);
      message = presentStoredMessage(messageId);
      publish(access.room.slug, { type: 'message', room: access.room.slug, message });
    } catch {
      return fail(500, 'send_failed');
    }
    if (planned.pending && ledger) ledger.mark(sessionId, agent.slug);
    return { ok: true, status: 201, message };
  }

  function buildContext(agent, slug, messageId) {
    const access = requireAgentRoom(slug, agent);
    if (!access.ok) return access;
    const parent = loadMessageRow(messageId);
    if (!parent || parent.room_id !== access.room.id) return fail(404, 'not_found');
    const rows = db.prepare(`
      SELECT m.*, u.username, a.slug AS agent_slug, a.name AS agent_name, a.panel
      FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.room_id = ? AND m.id <= ?
      ORDER BY m.id DESC
      LIMIT ?
    `).all(access.room.id, parent.id, config.contextMessages).reverse();
    const docs = documentsByMessage(rows.map((row) => row.id));
    const recent = rows.map((row) => presentMessage(row, docs.get(row.id) || []));
    const documents = [];
    for (const item of recent) {
      const full = docs.get(item.id) || [];
      for (const doc of full) {
        documents.push({
          name: doc.original_name,
          text: String(doc.extracted_text || '').slice(0, config.promptExtractChars),
          messageId: doc.message_id,
        });
      }
    }
    const flags = flagsForRooms([access.room.id]).slice(-config.contextMessages);
    const usage = getUsage(agent.id);
    return {
      ok: true,
      context: {
        room: { id: access.room.id, slug: access.room.slug, name: access.room.name },
        message: recent[recent.length - 1],
        recent,
        documents,
        flags: flags.map((flag) => ({ severity: flag.severity, title: flag.title })),
        roster: listMembers(access.room.id).map((member) => ({ name: member.name, kind: member.type })),
        usage: { tokens: usage.tokens, costCents: usage.cost_cents },
        maxHops,
        agent: {
          id: agent.id,
          slug: agent.slug,
          name: agent.name,
          role: agent.role,
          panel: agent.panel,
          systemPrompt: agent.system_prompt,
          allowedTools: parseJson(agent.allowed_tools, []),
          disclaimer: agent.disclaimer,
          dailyTokenCap: agent.daily_token_cap,
          dailyCostCapCents: agent.daily_cost_cap_cents,
          daily_token_cap: agent.daily_token_cap,
          daily_cost_cap_cents: agent.daily_cost_cap_cents,
        },
      },
    };
  }

  function createFlag(value) {
    const rooms = [];
    for (const slug of value.rooms) {
      const room = getRoomBySlug(slug);
      if (!room) return fail(400, 'rooms');
      rooms.push(room);
    }
    const known = new Set(db.prepare('SELECT slug FROM agents').all().map((agent) => agent.slug));
    const agents = value.affectedAgents.map((slug) => slug.toLowerCase());
    if (agents.some((slug) => !known.has(slug))) return fail(400, 'agents');
    const created = nowIso();
    const flagId = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO regulatory_flags (
          title, severity, summary, affected_projects, affected_agents,
          recommended_action, needs_lawyer, source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        value.title,
        value.severity,
        value.summary,
        JSON.stringify(value.affectedProjects),
        JSON.stringify(agents),
        value.recommendedAction,
        value.needsLawyer ? 1 : 0,
        value.sourceUrl,
        created,
      );
      const id = Number(info.lastInsertRowid);
      const link = db.prepare('INSERT INTO flag_rooms (flag_id, room_id) VALUES (?, ?)');
      for (const room of rooms) link.run(id, room.id);
      return id;
    })();
    const flag = hydrateFlags([db.prepare('SELECT * FROM regulatory_flags WHERE id = ?').get(flagId)])[0];
    for (const room of rooms) publish(room.slug, { type: 'flag', room: room.slug, flag });
    return { ok: true, status: 201, flag };
  }

  function listFlags(filters) {
    let rows = db.prepare('SELECT * FROM regulatory_flags ORDER BY id DESC LIMIT 200').all();
    if (filters.room) {
      const room = getRoomBySlug(filters.room);
      if (!room) return { ok: true, flags: [] };
      const ids = new Set(db.prepare('SELECT flag_id FROM flag_rooms WHERE room_id = ?').all(room.id).map((row) => row.flag_id));
      rows = rows.filter((row) => ids.has(row.id));
    }
    const flags = hydrateFlags(rows).filter((flag) => flagVisible(flag, filters));
    return { ok: true, flags };
  }

  function acknowledge(userId, flagId) {
    const flagRow = db.prepare('SELECT * FROM regulatory_flags WHERE id = ?').get(flagId);
    if (!flagRow) return fail(404, 'not_found');
    const rooms = db.prepare(`
      SELECT r.id, r.slug FROM flag_rooms fr JOIN rooms r ON r.id = fr.room_id WHERE fr.flag_id = ?
    `).all(flagId);
    if (!rooms.some((room) => membership(room.id, userId))) return fail(403, 'forbidden');
    db.prepare(`
      INSERT INTO flag_acknowledgements (flag_id, user_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT(flag_id, user_id) DO NOTHING
    `).run(flagId, userId, nowIso());
    const flag = hydrateFlags([flagRow])[0];
    for (const room of rooms) publish(room.slug, { type: 'flag', room: room.slug, flag });
    return { ok: true, flag, roomSlug: rooms[0]?.slug || '' };
  }

  function messageForMember(userId, messageId) {
    const row = loadMessageRow(messageId);
    if (!row) return fail(404, 'not_found');
    if (!membership(row.room_id, userId)) return fail(403, 'forbidden');
    return { ok: true, message: presentStoredMessage(messageId), roomId: row.room_id };
  }

  function createApproval(agent, slug, input) {
    const access = requireAgentRoom(slug, agent);
    if (!access.ok) return access;
    const parent = loadMessageRow(input.parentId);
    if (!parent || parent.room_id !== access.room.id) return fail(400, 'bad_parent');
    const decision = agentShouldRespond(agent, parent, { maxHops });
    if (!decision.respond) return fail(403, decision.reason);
    if (typeof input.threadId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.threadId)) return fail(400, 'invalid');
    if (typeof input.tool !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(input.tool)) return fail(400, 'invalid');
    const spend = clampUsage(input.usage || { tokens: 1, costCents: 0 });
    if (!canSpend(agent, getUsage(agent.id), spend).ok) {
      capNotice(agent, access.room);
      return fail(429, 'daily_cap');
    }
    const existing = db.prepare('SELECT * FROM tool_approvals WHERE thread_id = ?').get(input.threadId);
    if (existing) {
      return { ok: true, status: 200, approval: existing };
    }
    const toolInput = JSON.stringify(input.args || {}).slice(0, 2000);
    const info = db.prepare(`
      INSERT INTO tool_approvals (
        room_id, agent_id, message_id, thread_id, tool_name, tool_input, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(access.room.id, agent.id, parent.id, input.threadId, input.tool, toolInput, nowIso());
    addUsage(agent.id, spend);
    const approval = {
      id: Number(info.lastInsertRowid),
      threadId: input.threadId,
      parentId: parent.id,
      toolName: input.tool,
      toolInput,
      agentSlug: agent.slug,
      agentName: agent.name,
      roomSlug: access.room.slug,
      status: 'pending',
    };
    publish(access.room.slug, { type: 'approval', approval });
    return { ok: true, status: 201, approval };
  }

  function resolveApproval(userId, approvalId, decision) {
    if (decision !== 'approve' && decision !== 'deny') return fail(400, 'invalid');
    const row = db.prepare(`
      SELECT ta.*, r.slug AS room_slug, a.slug AS agent_slug
      FROM tool_approvals ta
      JOIN rooms r ON r.id = ta.room_id
      JOIN agents a ON a.id = ta.agent_id
      WHERE ta.id = ?
    `).get(approvalId);
    if (!row) return fail(404, 'not_found');
    const member = membership(row.room_id, userId);
    if (!member) return fail(403, 'forbidden');
    if (member.role !== 'owner') return fail(403, 'forbidden');
    if (row.status !== 'pending') {
      return {
        ok: true,
        approval: {
          id: row.id,
          threadId: row.thread_id,
          parentId: row.message_id,
          toolName: row.tool_name,
          toolInput: row.tool_input,
          agentSlug: row.agent_slug,
          roomSlug: row.room_slug,
          status: row.status,
        },
      };
    }
    const status = decision === 'approve' ? 'approved' : 'denied';
    db.prepare(
      'UPDATE tool_approvals SET status = ?, resolved_at = ? WHERE id = ?',
    ).run(status, nowIso(), row.id);
    const approval = {
      id: row.id,
      threadId: row.thread_id,
      parentId: row.message_id,
      toolName: row.tool_name,
      toolInput: row.tool_input,
      agentSlug: row.agent_slug,
      roomSlug: row.room_slug,
      status,
    };
    publish(row.room_slug, { type: 'approval', approval });
    return { ok: true, approval };
  }

  return {
    agentByToken,
    noteSession,
    sessionFor,
    ensureUserLobby,
    listRooms,
    getRoomBySlug,
    requireUserRoom,
    requireAgentRoom,
    listAgentRooms,
    createRoom,
    addMember,
    listMembers,
    listTimeline,
    listPendingApprovals,
    postUserMessage,
    postAgentMessage,
    buildContext,
    createFlag,
    listFlags,
    acknowledge,
    messageForMember,
    createApproval,
    resolveApproval,
    presentStoredMessage,
    getUsage,
    trading,
  };
}

module.exports = { createTeamService, slugify, cleanRoomName, displayTime };

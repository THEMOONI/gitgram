const crypto = require('crypto');
const { loadTeamConfig } = require('./config');
const { sha256 } = require('./secret');

function nowIso() {
  return new Date().toISOString();
}

function ensureTeamSchema(db, config = loadTeamConfig()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      panel TEXT NOT NULL DEFAULT 'standard',
      system_prompt TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      daily_token_cap INTEGER NOT NULL,
      daily_cost_cap_cents INTEGER NOT NULL,
      disclaimer TEXT NOT NULL DEFAULT '',
      token TEXT UNIQUE NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_usage (
      agent_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, day),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS room_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      member_type TEXT NOT NULL CHECK (member_type IN ('user', 'agent')),
      user_id INTEGER,
      agent_id INTEGER,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      CHECK (
        (member_type = 'user' AND user_id IS NOT NULL AND agent_id IS NULL) OR
        (member_type = 'agent' AND agent_id IS NOT NULL AND user_id IS NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS room_members_user_unique
      ON room_members(room_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS room_members_agent_unique
      ON room_members(room_id, agent_id) WHERE agent_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent', 'system')),
      user_id INTEGER,
      agent_id INTEGER,
      body TEXT NOT NULL,
      hop INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER,
      addressed_agent_id INTEGER,
      legal_tags TEXT NOT NULL DEFAULT '[]',
      risks TEXT NOT NULL DEFAULT '[]',
      badges TEXT NOT NULL DEFAULT '[]',
      disclaimer TEXT NOT NULL DEFAULT '',
      needs_lawyer INTEGER NOT NULL DEFAULT 0,
      ai_generated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE SET NULL,
      FOREIGN KEY (addressed_agent_id) REFERENCES agents(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS messages_room_idx ON messages(room_id, id);
  `);
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all();
  if (!messageColumns.some((column) => column.name === 'ai_generated')) {
    db.exec('ALTER TABLE messages ADD COLUMN ai_generated INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      message_id INTEGER,
      uploaded_by INTEGER,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      extracted_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS regulatory_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('hög', 'medel', 'låg')),
      summary TEXT NOT NULL,
      affected_projects TEXT NOT NULL,
      affected_agents TEXT NOT NULL,
      recommended_action TEXT NOT NULL,
      needs_lawyer INTEGER NOT NULL,
      source_url TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flag_rooms (
      flag_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      PRIMARY KEY (flag_id, room_id),
      FOREIGN KEY (flag_id) REFERENCES regulatory_flags(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS flag_acknowledgements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flag_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (flag_id, user_id),
      FOREIGN KEY (flag_id) REFERENCES regulatory_flags(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tool_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      message_id INTEGER,
      thread_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
    );
  `);
  seedTeam(db, config);
}

function composedPrompt(config, agent) {
  const prompt = String(agent.systemPrompt || '').trim();
  const boundary = String(config.sharedBoundaries || '').trim();
  if (!boundary || prompt.includes(boundary)) return prompt;
  return `${prompt}\n\n${boundary}`;
}

function seedTeam(db, config) {
  const insert = db.prepare(`
    INSERT INTO agents (
      slug, name, role, panel, system_prompt, model, allowed_tools,
      daily_token_cap, daily_cost_cap_cents, disclaimer, token, token_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE agents SET
      name = ?, role = ?, panel = ?, system_prompt = ?, model = ?, allowed_tools = ?,
      daily_token_cap = ?, daily_cost_cap_cents = ?, disclaimer = ?
    WHERE id = ?
  `);
  for (const agent of config.agents) {
    const existing = db.prepare('SELECT id FROM agents WHERE slug = ?').get(agent.slug);
    const tools = JSON.stringify(agent.allowedTools || []);
    const prompt = composedPrompt(config, agent);
    if (existing) {
      update.run(
        agent.name,
        agent.role,
        agent.panel,
        prompt,
        agent.model || '',
        tools,
        agent.dailyTokenCap,
        agent.dailyCostCapCents,
        agent.disclaimer || '',
        existing.id,
      );
      continue;
    }
    const token = crypto.randomBytes(32).toString('hex');
    insert.run(
      agent.slug,
      agent.name,
      agent.role,
      agent.panel,
      prompt,
      agent.model || '',
      tools,
      agent.dailyTokenCap,
      agent.dailyCostCapCents,
      agent.disclaimer || '',
      token,
      sha256(token),
      nowIso(),
    );
  }

  const addAgentMember = db.prepare(`
    INSERT INTO room_members (room_id, member_type, agent_id, role, created_at)
    VALUES (?, 'agent', ?, 'member', ?)
  `);
  const agents = db.prepare('SELECT id FROM agents').all();
  for (const channel of config.channels) {
    const visibility = channel.audience === 'owner' ? 'owner' : 'channel';
    let room = db.prepare('SELECT id, visibility FROM rooms WHERE slug = ?').get(channel.slug);
    if (!room) {
      const info = db.prepare(
        'INSERT INTO rooms (slug, name, visibility, created_at) VALUES (?, ?, ?, ?)',
      ).run(channel.slug, channel.name, visibility, nowIso());
      room = { id: Number(info.lastInsertRowid), visibility };
    } else if (room.visibility !== visibility) {
      db.prepare('UPDATE rooms SET visibility = ? WHERE id = ?').run(visibility, room.id);
    }
    for (const agent of agents) {
      const member = db.prepare(
        'SELECT id FROM room_members WHERE room_id = ? AND agent_id = ?',
      ).get(room.id, agent.id);
      if (!member) addAgentMember.run(room.id, agent.id, nowIso());
    }
  }
  require('./trading/store').ensureTradingSchema(db);
}

module.exports = { ensureTeamSchema, seedTeam, nowIso };

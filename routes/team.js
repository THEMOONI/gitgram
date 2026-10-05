const express = require('express');
const { bearerToken, tokensEqual } = require('../lib/team/secret');
const { validateFlagInput } = require('../lib/team/flags');
const { voiceNotice, spokenText, discardAudio, retainAudioFile, markGeneratedAudio } = require('../lib/team/voice');

function wantsJson(req) {
  return (req.get('content-type') || '').includes('application/json');
}

function parseFilters(query) {
  const severity = ['hög', 'medel', 'låg'].includes(query.severity) ? query.severity : '';
  const risk = ['LÅG', 'MEDEL', 'HÖG', 'EXTREM'].includes(query.risk) ? query.risk : '';
  const ack = ['open', 'done'].includes(query.ack) ? query.ack : 'all';
  const project = typeof query.project === 'string'
    ? query.project.replace(/[\u0000-\u001F]/g, '').trim().slice(0, 60)
    : '';
  const room = typeof query.room === 'string' && /^[a-z0-9][a-z0-9-]{0,38}$/.test(query.room)
    ? query.room
    : '';
  return { severity, risk, ack, project, room };
}

function safeBack(req, slug) {
  const back = req.get('referer');
  if (back) {
    try {
      const url = new URL(back);
      if (url.host === req.get('host') && url.pathname.startsWith('/team/')) {
        return url.pathname + url.search;
      }
    } catch {
      /* ignore malformed referer */
    }
  }
  return `/team/${slug}`;
}

function fileFromBody(body) {
  if (!body || body.file == null) return { file: null };
  const file = body.file;
  if (!file || typeof file.name !== 'string' || typeof file.dataBase64 !== 'string') {
    return { error: 'file_type' };
  }
  const buffer = Buffer.from(file.dataBase64, 'base64');
  if (!buffer.length) return { error: 'file_empty' };
  return { file: { name: file.name, buffer } };
}

function mountTeam(app, deps) {
  const {
    service, voice, config, flagsToken, messageLimiter, flagLimiter, dataDir, retainVoiceAudio,
    tradingAlertsToken, tradingLimiter,
  } = deps;
  const pages = express.Router();
  const api = express.Router();

  function requireUser(req, res) {
    if (!req.session.userId) {
      res.redirect('/login');
      return null;
    }
    service.ensureUserLobby(req.session.userId);
    return req.session.userId;
  }

  pages.get('/', (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const rooms = service.listRooms(userId);
    const target = rooms.find((room) => room.slug === 'general') || rooms[0];
    if (!target) return res.status(404).render('404', { title: 'Not Found - GITGRAM' });
    return res.redirect(`/team/${target.slug}`);
  });

  pages.post('/rooms', (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const created = service.createRoom(userId, req.body.name);
    if (!created.ok) return res.redirect('/team/general?error=name');
    return res.redirect(`/team/${created.room.slug}`);
  });

  pages.get('/:slug', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    service.ensureUserLobby(req.session.userId);
    const access = service.requireUserRoom(req.params.slug, req.session.userId);
    if (!access.ok) {
      if (access.status === 403) return res.status(403).send('You are not a member of this room');
      return res.status(404).render('404', { title: 'Not Found - GITGRAM' });
    }
    const filters = parseFilters(req.query);
    const timeline = service.listTimeline(access.room, filters);
    const errorCode = typeof req.query.error === 'string' ? req.query.error : '';
    const errors = { name: 'Use a room name of 2–60 characters.' };
    res.render('team', {
      title: `Team · #${access.room.slug} - GITGRAM`,
      rooms: service.listRooms(req.session.userId),
      room: access.room,
      role: access.role,
      members: service.listMembers(access.room.id),
      items: timeline.items,
      approvals: service.listPendingApprovals(access.room.id),
      filters,
      areas: config.legal.areas,
      copy: config.legal,
      voiceAvailable: voice.available,
      voiceNotice: voiceNotice(config),
      sendsAudioToCloud: Boolean(voice.sendsAudioToCloud),
      voiceCloudNotice: config.voiceCloudNotice,
      voiceLocalNotice: config.voiceLocalNotice,
      voiceRetentionNotice: retainVoiceAudio ? config.voiceRetentionOnNotice : config.voiceRetentionNotice,
      voiceDisclosure: config.voiceDisclosure,
      aiAgentBadge: config.aiAgentBadge,
      aiGeneratedLabel: config.aiGeneratedLabel,
      retainVoiceAudio: Boolean(retainVoiceAudio),
      pageError: errors[errorCode] || '',
      isTrading: access.room.visibility === 'owner',
      tradingDemoLabel: config.tradingDemoLabel,
      tradingDisclaimer: config.tradingDisclaimer,
      tradingNoticeDisclaimer: config.tradingNoticeDisclaimer,
      tradingWatcherOffline: config.tradingWatcherOffline,
      tradingNotices: timeline.notices,
      watcherOffline: timeline.watcherOffline,
      bootstrap: {
        room: access.room.slug,
        csrfToken: res.locals.csrfToken,
        filters,
        trading: access.room.visibility === 'owner',
        ...(access.room.visibility === 'owner' ? {
          tradingNoticeDisclaimer: config.tradingNoticeDisclaimer,
          ...(service.trading.pullEnabled() ? { tradingWatcherOffline: config.tradingWatcherOffline } : {}),
        } : {}),
        voiceAvailable: voice.available,
        sendsAudioToCloud: Boolean(voice.sendsAudioToCloud),
        voiceCloudNotice: config.voiceCloudNotice,
        voiceLocalNotice: config.voiceLocalNotice,
        voiceDisclosure: config.voiceDisclosure,
        aiAgentBadge: config.aiAgentBadge,
        aiGeneratedLabel: config.aiGeneratedLabel,
        maxUploadBytes: config.maxUploadBytes,
        areas: config.areaLabels,
        micNotice: config.micUnavailableNotice,
      },
    });
  });

  function flagsOn() {
    return typeof flagsToken === 'string' && flagsToken.length > 0;
  }

  function requireFlagToken(req, res) {
    if (!flagsOn()) {
      res.status(404).json({ error: 'not_found' });
      return false;
    }
    const ip = req.ip || req.socket?.remoteAddress || 'local';
    if (!flagLimiter.allow(`flags:${ip}`)) {
      res.status(429).json({ error: 'rate_limit' });
      return false;
    }
    const provided = bearerToken(req.get('authorization'));
    if (!provided || !tokensEqual(provided, flagsToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  function alertsOn() {
    return typeof tradingAlertsToken === 'string' && tradingAlertsToken.length > 0;
  }

  api.post('/trading-alerts', (req, res) => {
    if (!alertsOn()) return res.status(404).json({ error: 'not_found' });
    const ip = req.ip || req.socket?.remoteAddress || 'local';
    if (tradingLimiter && !tradingLimiter.allow(`post:${ip}`)) {
      return res.status(429).json({ error: 'rate_limit' });
    }
    const provided = bearerToken(req.get('authorization'));
    if (!provided || !tokensEqual(provided, tradingAlertsToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!tradingLimiter || !tradingLimiter.allow('trading-alerts')) {
      return res.status(429).json({ error: 'rate_limit' });
    }
    const result = service.trading.ingest(req.body, { skipLimit: true });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (result.ignored) return res.status(200).json({ ignored: result.ignored });
    if (result.deduped) return res.status(200).json({ deduped: true, alert: result.alert });
    return res.status(201).json({ alert: result.alert });
  });

  api.post('/trading-alerts/:id/ack', (req, res) => {
    if (req.get('authorization')) return res.status(400).json({ error: 'invalid' });
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const result = service.trading.acknowledge(req.session.userId, Number(req.params.id));
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (wantsJson(req)) return res.json({ alert: result.alert });
    return res.redirect(safeBack(req, result.roomSlug));
  });

  api.post('/flags', (req, res) => {
    if (!requireFlagToken(req, res)) return;
    const parsed = validateFlagInput(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = service.createFlag(parsed.value);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(201).json({ flag: result.flag });
  });

  api.get('/flags', (req, res) => {
    if (!requireFlagToken(req, res)) return;
    const result = service.listFlags(parseFilters(req.query));
    return res.json({ flags: result.flags });
  });

  api.post('/flags/:id/ack', (req, res) => {
    if (req.get('authorization')) return res.status(400).json({ error: 'invalid' });
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const result = service.acknowledge(req.session.userId, Number(req.params.id));
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (wantsJson(req)) return res.json({ flag: result.flag });
    return res.redirect(safeBack(req, result.roomSlug));
  });

  api.get('/rooms/:slug/timeline', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const access = service.requireUserRoom(req.params.slug, req.session.userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const filters = parseFilters(req.query);
    return res.json({
      items: service.listTimeline(access.room, filters).items,
      members: service.listMembers(access.room.id),
    });
  });

  api.get('/rooms/:slug/context', (req, res) => {
    const agent = service.agentByToken(bearerToken(req.get('authorization')));
    if (!agent) return res.status(401).json({ error: 'unauthorized' });
    const result = service.buildContext(agent, req.params.slug, Number(req.query.messageId));
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ context: result.context });
  });

  api.post('/rooms/:slug/messages', (req, res) => {
    const header = req.get('authorization');
    if (header) {
      const agent = service.agentByToken(bearerToken(header));
      if (!agent) return res.status(401).json({ error: 'unauthorized' });
      if (!messageLimiter.allow(`agent:${agent.id}`)) return res.status(429).json({ error: 'rate_limit' });
      const result = service.postAgentMessage(agent, req.params.slug, req.body || {});
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.status(201).json({ message: result.message });
    }
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    if (!messageLimiter.allow(`user:${req.session.userId}`)) return res.status(429).json({ error: 'rate_limit' });
    const uploaded = fileFromBody(req.body);
    if (uploaded.error) return res.status(400).json({ error: uploaded.error });
    const result = service.postUserMessage(req.session.userId, req.params.slug, {
      body: req.body?.body,
      legalTags: req.body?.legalTags,
      addressedAgentId: req.body?.addressedAgentId,
      contractText: req.body?.contractText,
      file: uploaded.file,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(201).json({ message: result.message });
  });

  api.post('/rooms/:slug/members', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const result = service.addMember(req.session.userId, req.params.slug, req.body?.username);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(result.status).json({ ok: true });
  });

  api.post('/rooms/:slug/stt', express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    if (!voice.available) {
      return res.status(503).json({ error: 'voice_unavailable', message: voiceNotice(config) });
    }
    if (!messageLimiter.allow(`stt:${req.session.userId}`)) return res.status(429).json({ error: 'rate_limit' });
    const audio = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : Buffer.alloc(0);
    if (!audio.length) return res.status(400).json({ error: 'audio' });
    try {
      const transcript = await voice.transcribe(audio, req.get('content-type'));
      if (!transcript.text) return res.status(400).json({ error: 'audio' });
      if (retainVoiceAudio) retainAudioFile(dataDir, audio, req.get('content-type'));
      const result = service.postUserMessage(req.session.userId, req.params.slug, { body: transcript.text });
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.status(201).json({ transcript: transcript.text, message: result.message });
    } catch (error) {
      if (error.code === 'VOICE_UNAVAILABLE') {
        return res.status(503).json({ error: 'voice_unavailable', message: voiceNotice(config) });
      }
      return res.status(502).json({ error: 'voice_failed' });
    } finally {
      discardAudio(audio);
      if (Buffer.isBuffer(req.body)) discardAudio(req.body);
    }
  });

  api.get('/messages/:id/speak', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    if (!voice.available) {
      return res.status(503).json({ error: 'voice_unavailable', message: voiceNotice(config) });
    }
    if (!messageLimiter.allow(`tts:${req.session.userId}`)) return res.status(429).json({ error: 'rate_limit' });
    const found = service.messageForMember(req.session.userId, Number(req.params.id));
    if (!found.ok) return res.status(found.status).json({ error: found.error });
    try {
      const disclose = !req.session.voiceDisclosurePlayed;
      const text = spokenText(found.message.body, {
        disclose,
        disclosure: config.voiceDisclosure,
      });
      const spoken = await voice.synthesize(text);
      if (disclose) req.session.voiceDisclosurePlayed = true;
      const audio = markGeneratedAudio(spoken.audio, spoken.contentType, {
        provider: voice.name,
        model: voice.model,
        generatedAt: new Date().toISOString(),
      });
      res.set('Content-Type', spoken.contentType);
      res.set('X-AI-Generated', 'true');
      res.set('X-Gitgram-Ai-Disclosure', disclose ? '1' : '0');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, no-store');
      return res.send(audio);
    } catch (error) {
      if (error.code === 'VOICE_UNAVAILABLE') {
        return res.status(503).json({ error: 'voice_unavailable', message: voiceNotice(config) });
      }
      return res.status(502).json({ error: 'voice_failed' });
    }
  });

  api.post('/approvals/:id', (req, res) => {
    if (req.get('authorization')) return res.status(400).json({ error: 'invalid' });
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const decision = req.body?.decision;
    const result = service.resolveApproval(req.session.userId, Number(req.params.id), decision);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (wantsJson(req)) return res.json({ approval: result.approval });
    return res.redirect(safeBack(req, result.approval.roomSlug));
  });

  app.use('/api/team', api);
  app.use('/team', pages);
}

module.exports = mountTeam;

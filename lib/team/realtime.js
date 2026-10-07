const { WebSocketServer } = require('ws');
const { bearerToken } = require('./secret');

function createHub() {
  const rooms = new Map();
  const agentSockets = new Set();
  return {
    join(slug, ws) {
      if (!ws.teamRooms) ws.teamRooms = new Set();
      if (!rooms.has(slug)) rooms.set(slug, new Set());
      rooms.get(slug).add(ws);
      ws.teamRooms.add(slug);
    },
    track(ws) {
      if (ws.teamAuth?.type === 'agent') agentSockets.add(ws);
    },
    addAgents(slug, agentIds) {
      const wanted = new Set(agentIds);
      for (const ws of agentSockets) {
        if (wanted.has(ws.teamAuth.agent.id)) this.join(slug, ws);
      }
    },
    leave(ws) {
      agentSockets.delete(ws);
      for (const slug of ws.teamRooms || []) rooms.get(slug)?.delete(ws);
      if (ws.teamRooms) ws.teamRooms.clear();
    },
    broadcast(slug, event) {
      const data = JSON.stringify(event);
      for (const ws of rooms.get(slug) || []) {
        if (ws.readyState === 1) {
          try { ws.send(data); } catch { /* socket closing */ }
        }
      }
    },
  };
}

function applySession(middleware, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      getHeader() { return undefined; },
      setHeader() { return this; },
      removeHeader() {},
      writeHead() { return this; },
      end() {},
      write() { return true; },
      on() { return this; },
      once() { return this; },
      emit() { return false; },
    };
    middleware(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function browserOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin || !req.headers.host) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, status) {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden';
  const body = reason;
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
}

function attachTeamRealtime(server, app) {
  const hub = app.locals.teamHub;
  const service = app.locals.teamService;
  const limiter = app.locals.teamMessageLimiter;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });

  function send(ws, event) {
    if (ws.readyState === 1) ws.send(JSON.stringify(event));
  }

  function onUser(ws, event) {
    const userId = ws.teamAuth.userId;
    if (event.type === 'join') {
      const access = service.requireUserRoom(event.room, userId);
      if (!access.ok) return send(ws, { type: 'error', error: access.error });
      hub.join(access.room.slug, ws);
      return send(ws, { type: 'joined', room: access.room.slug });
    }
    if (event.type === 'message') {
      if (!limiter.allow(`user:${userId}`)) return send(ws, { type: 'error', error: 'rate_limit' });
      const result = service.postUserMessage(userId, event.room, {
        body: event.body,
        legalTags: event.legalTags,
        addressedAgentId: event.addressedAgentId,
        sessionId: ws.sessionId,
      });
      if (!result.ok) return send(ws, { type: 'error', error: result.error });
    }
  }

  function onAgent(ws, event) {
    const agent = ws.teamAuth.agent;
    if (event.type === 'message') {
      if (!limiter.allow(`agent:${agent.id}`)) {
        return send(ws, { type: 'result', parentId: event.parentId, ok: false, error: 'rate_limit' });
      }
      const result = service.postAgentMessage(agent, event.room, event);
      return send(ws, {
        type: 'result',
        parentId: event.parentId,
        ok: result.ok,
        error: result.ok ? '' : result.error,
      });
    }
    if (event.type === 'approval_request') {
      if (!limiter.allow(`agent:${agent.id}`)) {
        return send(ws, { type: 'result', threadId: event.threadId, ok: false, error: 'rate_limit' });
      }
      const result = service.createApproval(agent, event.room, event);
      return send(ws, {
        type: 'result',
        threadId: event.threadId,
        ok: result.ok,
        error: result.ok ? '' : result.error,
      });
    }
  }

  wss.on('connection', (ws) => {
    ws.on('message', (buf) => {
      let event;
      try {
        event = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (!event || typeof event !== 'object') return;
      try {
        if (ws.teamAuth.type === 'agent') onAgent(ws, event);
        else onUser(ws, event);
      } catch (error) {
        send(ws, { type: 'error', error: 'invalid' });
      }
    });
    ws.on('close', () => hub.leave(ws));
    hub.track(ws);
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/team/ws') {
      socket.destroy();
      return;
    }
    applySession(app.locals.sessionMiddleware, req).then(() => {
      const token = bearerToken(req.headers.authorization);
      if (token) {
        const agent = service.agentByToken(token);
        if (!agent) return rejectUpgrade(socket, 401);
        return wss.handleUpgrade(req, socket, head, (ws) => {
          ws.teamAuth = { type: 'agent', agent };
          ws.teamRooms = new Set();
          for (const room of service.listAgentRooms(agent.id)) hub.join(room.slug, ws);
          wss.emit('connection', ws, req);
        });
      }
      if (!req.session || !req.session.userId) return rejectUpgrade(socket, 401);
      if (!browserOriginOk(req)) return rejectUpgrade(socket, 403);
      try {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        ws.teamAuth = { type: 'user', userId: req.session.userId };
        ws.sessionId = req.sessionID;
        ws.teamRooms = new Set();
        wss.emit('connection', ws, req);
      });
      } catch {
        socket.destroy();
      }
    }).catch(() => {
      socket.destroy();
    });
  });

  return hub;
}

module.exports = { createHub, attachTeamRealtime, browserOriginOk };

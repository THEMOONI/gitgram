const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { createModel } = require('../lib/team/model');
const { planAgentReply, resumePlannedReply } = require('../lib/team/turn');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wsUrl(base) {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/team/ws';
  url.search = '';
  return url.toString();
}

async function loadAgents(dbPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { fileMustExist: true, timeout: 2000 });
        const rows = db.prepare('SELECT slug, name, token FROM agents ORDER BY id').all();
        db.close();
        if (rows.length) return rows;
      } catch {
        /* server may still be creating the file */
      }
    }
    await sleep(200);
  }
  throw new Error('No seeded agents found. Start the Gitgram server before the agent runner.');
}

async function requestJson(base, token, urlPath, options = {}) {
  const response = await fetch(new URL(urlPath, base), {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function ask(ws, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve({ ok: false, error: 'timeout' });
    }, 8000);
    function onMessage(raw) {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const sameParent = payload.parentId != null && event.parentId === payload.parentId;
      const sameThread = payload.threadId && event.threadId === payload.threadId;
      if (event.type === 'result' && (sameParent || sameThread)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(event);
      }
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify(payload));
  });
}

async function respond(ws, agent, base, model, event, pending) {
  const message = event.message;
  if (!message || message.authorType === 'system' || message.agentSlug === agent.slug) return;
  const loaded = await requestJson(
    base,
    agent.token,
    `/api/team/rooms/${encodeURIComponent(event.room)}/context?messageId=${message.id}`,
  );
  if (!loaded.ok) return;
  const context = loaded.data.context;
  const plan = await planAgentReply({
    model,
    agent: context.agent,
    context,
    maxHops: context.maxHops,
  });
  if (plan.action === 'skip') return;
  if (plan.action === 'approval') {
    pending.set(plan.threadId, { parentId: message.id, room: event.room });
    await ask(ws, {
      type: 'approval_request',
      room: event.room,
      parentId: message.id,
      threadId: plan.threadId,
      tool: plan.tool,
      args: plan.args,
      usage: plan.usage,
    });
    return;
  }
  await ask(ws, {
    type: 'message',
    room: event.room,
    body: plan.body,
    parentId: message.id,
    usage: plan.usage,
    needsLawyer: plan.needsLawyer,
    risks: plan.risks,
    legalTags: plan.legalTags,
  });
}

function connectAgent(agent, base, model, state) {
  const ws = new WebSocket(wsUrl(base), {
    headers: { Authorization: `Bearer ${agent.token}` },
  });
  const pending = new Map();
  let chain = Promise.resolve();
  ws.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (event.type === 'approval' && event.approval?.agentSlug === agent.slug && event.approval.status !== 'pending') {
      const saved = pending.get(event.approval.threadId);
      if (!saved) return;
      pending.delete(event.approval.threadId);
      chain = chain.then(async () => {
        const decision = event.approval.status === 'approved' ? 'approve' : 'deny';
        const resumed = await resumePlannedReply({ model, threadId: event.approval.threadId, decision });
        if (!resumed.body) return;
        await ask(ws, {
          type: 'message',
          room: saved.room,
          body: resumed.body,
          parentId: saved.parentId,
          usage: resumed.usage,
        });
      }).catch((error) => {
        console.error(`${agent.slug} resume failed: ${error.message}`);
      });
      return;
    }
    if (event.type !== 'message' || !event.room) return;
    chain = chain.then(() => respond(ws, agent, base, model, event, pending)).catch((error) => {
      console.error(`${agent.slug} turn failed: ${error.message}`);
    });
  });
  ws.on('open', () => {
    state.open.add(agent.slug);
    if (state.open.size === state.expected && !state.announced) {
      state.announced = true;
      console.log(`agent runner ready ${[...state.open].sort().join(',')}`);
    }
  });
  ws.on('close', () => {
    state.open.delete(agent.slug);
    if (!state.stopped) {
      setTimeout(() => connectAgent(agent, base, model, state), 1000);
    }
  });
  ws.on('error', () => {
    /* close handler reconnects */
  });
  return ws;
}

async function main() {
  const dbPath = process.env.GITGRAM_DB || path.join(__dirname, '..', 'db', 'gitgram.db');
  const base = process.env.GITGRAM_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const agents = await loadAgents(dbPath);
  const model = createModel(process.env);
  const state = { open: new Set(), expected: agents.length, announced: false, stopped: false };
  const sockets = agents.map((agent) => connectAgent(agent, base, model, state));
  function stop() {
    state.stopped = true;
    for (const socket of sockets) socket.close();
    process.exit(0);
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main, wsUrl };

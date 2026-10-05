const crypto = require('crypto');

const GENESIS = 'GENESIS';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function chainHash(prev, ts, actorType, actorId, action, payloadJson) {
  return crypto.createHash('sha256')
    .update(String(prev) + '\n' + ts + '\n' + actorType + '\n' + actorId + '\n' + action + '\n' + payloadJson)
    .digest('hex');
}

function appendAudit(db, entry) {
  const payloadJson = typeof entry.payload === 'string' ? entry.payload : stableStringify(entry.payload);
  const prev = db.prepare('SELECT hash FROM paper_audit_log ORDER BY id DESC LIMIT 1').get();
  const prevHash = prev ? prev.hash : GENESIS;
  const hash = chainHash(prevHash, entry.ts, entry.actorType, entry.actorId, entry.action, payloadJson);
  db.prepare(`
    INSERT INTO paper_audit_log (ts, actor_type, actor_id, action, payload_json, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.ts, entry.actorType, entry.actorId, entry.action, payloadJson, prevHash, hash);
  return hash;
}

function verifyRows(rows) {
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { ok: false, id: row.id, reason: 'prev' };
    const expected = chainHash(row.prev_hash, row.ts, row.actor_type, row.actor_id, row.action, row.payload_json);
    if (expected !== row.hash) return { ok: false, id: row.id, reason: 'hash' };
    prev = row.hash;
  }
  return { ok: true, count: rows.length };
}

function verifyAudit(db) {
  const rows = db.prepare('SELECT * FROM paper_audit_log ORDER BY id ASC').all();
  return verifyRows(rows);
}

module.exports = {
  GENESIS,
  stableStringify,
  chainHash,
  appendAudit,
  verifyRows,
  verifyAudit,
};

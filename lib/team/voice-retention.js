const fs = require('fs');
const path = require('path');
const { CONSENT_TEXT, CONSENT_VERSION, MAX_RETAIN_DAYS } = require('./voice-policy');

function addDays(iso, days) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function createVoiceRetention(db, dataDir) {
  const transcripts = new Map();

  function rememberTranscript(sessionId, userId, text) {
    if (!sessionId) return;
    transcripts.set(String(sessionId), { userId, text: String(text || '') });
  }

  function endSession(sessionId) {
    transcripts.delete(String(sessionId));
  }

  function transcriptFor(sessionId) {
    return transcripts.get(String(sessionId)) || null;
  }

  function activeCount() {
    return transcripts.size;
  }

  function logConsent(userId, granted, now = new Date().toISOString()) {
    const info = db.prepare(`
      INSERT INTO voice_consents (user_id, granted, text_version, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, granted ? 1 : 0, CONSENT_VERSION, now);
    return {
      id: Number(info.lastInsertRowid),
      userId,
      granted: Boolean(granted),
      textVersion: CONSENT_VERSION,
      text: CONSENT_TEXT,
      createdAt: now,
    };
  }

  function latestConsent(userId) {
    return db.prepare(`
      SELECT id, user_id, granted, text_version, created_at
      FROM voice_consents
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(userId) || null;
  }

  function consentAllowsRecording(userId) {
    const row = latestConsent(userId);
    return Boolean(row && row.granted && row.text_version === CONSENT_VERSION);
  }

  function purgeExpired(now = new Date().toISOString()) {
    const rows = db.prepare('SELECT id, stored_path FROM voice_recordings WHERE expires_at <= ?').all(now);
    const remove = db.prepare('DELETE FROM voice_recordings WHERE id = ?');
    for (const row of rows) {
      try { fs.unlinkSync(row.stored_path); } catch { /* already gone */ }
      remove.run(row.id);
    }
    return rows.length;
  }

  function storeRecording(userId, filePath, consentId, now = new Date().toISOString()) {
    const expiresAt = addDays(now, MAX_RETAIN_DAYS);
    const info = db.prepare(`
      INSERT INTO voice_recordings (user_id, consent_id, stored_path, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, consentId || null, filePath, now, expiresAt);
    return {
      id: Number(info.lastInsertRowid),
      expiresAt,
      createdAt: now,
    };
  }

  function listRecordings(userId) {
    purgeExpired();
    return db.prepare(`
      SELECT id, created_at, expires_at FROM voice_recordings
      WHERE user_id = ? ORDER BY id DESC
    `).all(userId).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  function deleteRecording(userId, recordingId) {
    const row = db.prepare(
      'SELECT id, stored_path FROM voice_recordings WHERE id = ? AND user_id = ?',
    ).get(recordingId, userId);
    if (!row) return false;
    try { fs.unlinkSync(row.stored_path); } catch { /* already gone */ }
    db.prepare('DELETE FROM voice_recordings WHERE id = ?').run(row.id);
    return true;
  }

  function deleteAll(userId) {
    const rows = db.prepare('SELECT id FROM voice_recordings WHERE user_id = ?').all(userId);
    let removed = 0;
    for (const row of rows) {
      if (deleteRecording(userId, row.id)) removed += 1;
    }
    return removed;
  }

  return {
    consentText: CONSENT_TEXT,
    consentVersion: CONSENT_VERSION,
    maxDays: MAX_RETAIN_DAYS,
    rememberTranscript,
    endSession,
    transcriptFor,
    activeCount,
    logConsent,
    latestConsent,
    consentAllowsRecording,
    purgeExpired,
    storeRecording,
    listRecordings,
    deleteRecording,
    deleteAll,
    retainedDir: path.join(dataDir, 'voice-retained'),
  };
}

module.exports = { createVoiceRetention, addDays, CONSENT_TEXT, CONSENT_VERSION, MAX_RETAIN_DAYS };

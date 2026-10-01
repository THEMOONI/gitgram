const { validateTradingAlert, safeDexScreenerUrl } = require('./validate');
const { fieldsHaveTradeWording, redactText } = require('./wording');
const { createExcludeList } = require('./exclude');
const {
  SIX_HOURS_MS,
  TEN_MINUTES_MS,
  parseQuietHours,
  isQuietHour,
  decideNotification,
  watcherIsSilent,
} = require('./notify');

function displayTime(iso) {
  return String(iso || '').replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '').slice(0, 16);
}

function ensureTradingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trading_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE NOT NULL,
      room_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      token_name TEXT,
      label TEXT NOT NULL CHECK (label IN ('LÅG', 'MEDEL', 'HÖG', 'EXTREM')),
      score INTEGER NOT NULL,
      stage TEXT NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      liquidity_usd REAL,
      top_reasons TEXT NOT NULL,
      link TEXT NOT NULL,
      ts TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      superseded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS trading_alerts_room_idx ON trading_alerts(room_id, superseded, id);
    CREATE INDEX IF NOT EXISTS trading_alerts_mint_idx ON trading_alerts(mint, ts_ms);
    CREATE TABLE IF NOT EXISTS trading_alert_acks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (alert_id, user_id),
      FOREIGN KEY (alert_id) REFERENCES trading_alerts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS trading_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('push', 'quiet', 'overflow')),
      sound INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (alert_id) REFERENCES trading_alerts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS trading_notifications_time_idx ON trading_notifications(created_at_ms, kind);
    CREATE INDEX IF NOT EXISTS trading_notifications_mint_idx ON trading_notifications(mint, created_at_ms);
  `);
}

function createTradingAlerts(db, options) {
  ensureTradingSchema(db);
  const config = options.config;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const exclude = createExcludeList(options.excludeFile || '', now);
  const minLiquidity = Number.isFinite(options.minLiquidityUsd)
    ? options.minLiquidityUsd
    : (config.tradingMinLiquidityUsd || 10_000);
  const quietRange = parseQuietHours(
    options.quietHours === undefined ? '0-7' : options.quietHours,
  );
  const limiter = options.limiter;
  const state = options.watcherState || {
    configured: false,
    pumpportalConnected: null,
    lastEventMs: 0,
    streamConnected: false,
  };
  const hub = options.hub;

  function publish(event) {
    if (hub) hub.broadcast('trading', event);
  }

  function tradingRoom() {
    return db.prepare("SELECT * FROM rooms WHERE slug = 'trading'").get() || null;
  }

  function noteEvent(tsMs) {
    if (!Number.isFinite(tsMs)) return;
    if (tsMs > state.lastEventMs) state.lastEventMs = tsMs;
    publishStatus();
  }

  function isSilent() {
    return watcherIsSilent(state, now());
  }

  function pullEnabled() {
    return Boolean(state.configured);
  }

  function publishStatus() {
    const offline = isSilent();
    if (state.lastSilent === offline) return;
    state.lastSilent = offline;
    publish({
      type: 'trading_status',
      room: 'trading',
      offline,
      text: offline ? (config.tradingWatcherOffline || '') : '',
    });
  }

  function noteStats(stats) {
    if (!stats || typeof stats.pumpportal_connected !== 'boolean') state.pumpportalConnected = false;
    else state.pumpportalConnected = stats.pumpportal_connected;
    publishStatus();
  }

  function noteStream(connected) {
    state.streamConnected = Boolean(connected);
    publishStatus();
  }

  function latestTs() {
    const row = db.prepare('SELECT MAX(ts_ms) AS ts FROM trading_alerts').get();
    return row && Number.isFinite(row.ts) ? row.ts : 0;
  }

  function acknowledgementsFor(ids) {
    const grouped = new Map();
    if (!ids.length) return grouped;
    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT aa.alert_id, aa.created_at, u.username
      FROM trading_alert_acks aa
      JOIN users u ON u.id = aa.user_id
      WHERE aa.alert_id IN (${marks})
      ORDER BY aa.id
    `).all(...ids);
    for (const row of rows) {
      const list = grouped.get(row.alert_id) || [];
      list.push({
        username: row.username,
        createdAt: row.created_at,
        displayTime: displayTime(row.created_at),
      });
      grouped.set(row.alert_id, list);
    }
    return grouped;
  }

  function present(row, acknowledgements = []) {
    const reasons = JSON.parse(row.top_reasons || '[]').slice(0, 3).map((reason) => redactText(reason));
    const link = safeDexScreenerUrl(row.link, row.mint);
    return {
      id: row.id,
      kind: 'trading_alert',
      externalId: row.external_id,
      mint: row.mint,
      symbol: redactText(row.symbol || ''),
      name: redactText(row.token_name || ''),
      label: row.label,
      score: row.score,
      stage: row.stage,
      source: row.source,
      summary: redactText(row.summary),
      reasons,
      link,
      safeUrl: link,
      demoLabel: config.tradingDemoLabel,
      disclaimer: config.tradingDisclaimer,
      createdAt: row.created_at,
      displayTime: displayTime(row.created_at),
      acknowledgements,
    };
  }

  function loadAlert(id) {
    const row = db.prepare('SELECT * FROM trading_alerts WHERE id = ?').get(id);
    if (!row) return null;
    const acks = acknowledgementsFor([id]).get(id) || [];
    return present(row, acks);
  }

  function alertVisible(alert, filters) {
    if (filters.risk && alert.label !== filters.risk) return false;
    if (filters.ack === 'open' && alert.acknowledgements.length) return false;
    if (filters.ack === 'done' && !alert.acknowledgements.length) return false;
    return true;
  }

  function listVisible(roomId, filters = {}) {
    const rows = db.prepare(`
      SELECT * FROM trading_alerts
      WHERE room_id = ? AND superseded = 0
      ORDER BY ts_ms ASC, id ASC
      LIMIT 200
    `).all(roomId);
    const acks = acknowledgementsFor(rows.map((row) => row.id));
    return rows
      .map((row) => present(row, acks.get(row.id) || []))
      .filter((alert) => alertVisible(alert, filters));
  }

  function listNotices() {
    const rows = db.prepare(`
      SELECT n.id, n.kind, n.sound, n.created_at_ms, a.summary
      FROM trading_notifications n
      JOIN trading_alerts a ON a.id = n.alert_id
      WHERE n.kind IN ('push', 'quiet')
      ORDER BY n.id DESC
      LIMIT 20
    `).all().reverse();
    const overflow = db.prepare(`
      SELECT COUNT(*) AS n FROM trading_notifications
      WHERE kind = 'overflow' AND created_at_ms >= ?
    `).get(now() - TEN_MINUTES_MS).n;
    const quiet = isQuietHour(new Date(now()), quietRange);
    const short = config.tradingNoticeDisclaimer || '';
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        sound: Boolean(row.sound) && !quiet,
        text: `${redactText(row.summary)} ${short}`.trim(),
        createdAt: new Date(row.created_at_ms).toISOString(),
        displayTime: displayTime(new Date(row.created_at_ms).toISOString()),
      })),
      digest: overflow ? `${overflow} nya signaler i #trading` : '',
      digestSound: Boolean(overflow) && !quiet && !isSilent(),
    };
  }

  function recentMint(mint, sinceMs) {
    return Boolean(db.prepare(`
      SELECT 1 FROM trading_notifications
      WHERE mint = ? AND kind IN ('push', 'quiet', 'overflow') AND created_at_ms >= ?
      LIMIT 1
    `).get(mint, sinceMs));
  }

  function recentPushCount(sinceMs) {
    return db.prepare(`
      SELECT COUNT(*) AS n FROM trading_notifications
      WHERE kind IN ('push', 'quiet') AND created_at_ms >= ?
    `).get(sinceMs).n;
  }

  function fastStep(value) {
    return value.stage === 'snabb' && value.source === 'pumpportal-ny';
  }

  function ingest(payload, { skipLimit = false } = {}) {
    const parsed = validateTradingAlert(payload);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const value = parsed.value;
    noteEvent(value.tsMs);
    const existing = db.prepare('SELECT id FROM trading_alerts WHERE external_id = ?').get(value.id);
    if (existing) {
      return { ok: true, status: 200, deduped: true, alert: loadAlert(existing.id), tsMs: value.tsMs };
    }
    if (exclude.has(value.mint)) return { ok: true, status: 200, ignored: 'excluded', tsMs: value.tsMs };
    if (!skipLimit && limiter && !limiter.allow('trading-alerts')) {
      return { ok: false, status: 429, error: 'rate_limit', tsMs: value.tsMs };
    }
    if (fieldsHaveTradeWording([
      value.summary,
      value.symbol,
      value.name,
      ...value.reasons,
      payload && payload.disclaimer,
    ])) {
      return { ok: false, status: 400, error: 'wording', tsMs: value.tsMs };
    }
    if (fastStep(value)) return { ok: true, status: 200, ignored: 'stage', tsMs: value.tsMs };
    const room = tradingRoom();
    if (!room) return { ok: false, status: 500, error: 'not_ready', tsMs: value.tsMs };
    const clock = now();
    const quiet = isQuietHour(new Date(clock), quietRange);
    const silent = isSilent();
    let saved;
    try {
      saved = db.transaction(() => {
      if (value.stage === 'uppföljning') {
        db.prepare(`
          UPDATE trading_alerts SET superseded = 1
          WHERE room_id = ? AND mint = ? AND superseded = 0
        `).run(room.id, value.mint);
      }
      const info = db.prepare(`
        INSERT INTO trading_alerts (
          external_id, room_id, mint, symbol, token_name, label, score, stage, source,
          summary, liquidity_usd, top_reasons, link, ts, ts_ms, superseded, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        value.id,
        room.id,
        value.mint,
        value.symbol,
        value.name,
        value.label,
        value.score,
        value.stage,
        value.source,
        value.summary,
        value.liquidityUsd,
        JSON.stringify(value.reasons),
        value.link,
        value.ts,
        value.tsMs,
        value.ts,
      );
      const id = Number(info.lastInsertRowid);
      const decision = decideNotification({
        alert: value,
        now: clock,
        silent,
        minLiquidity,
        quiet,
        recentMint: recentMint(value.mint, clock - SIX_HOURS_MS),
        recentPushCount: recentPushCount(clock - TEN_MINUTES_MS),
      });
      if (decision.action !== 'none') {
        db.prepare(`
          INSERT INTO trading_notifications (alert_id, mint, kind, sound, created_at_ms)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, value.mint, decision.action, decision.sound ? 1 : 0, clock);
      }
      return { id, decision };
    })();
    } catch (error) {
      if (String(error && error.message).includes('UNIQUE')) {
        const again = db.prepare('SELECT id FROM trading_alerts WHERE external_id = ?').get(value.id);
        if (again) return { ok: true, status: 200, deduped: true, alert: loadAlert(again.id), tsMs: value.tsMs };
      }
      throw error;
    }
    const alert = loadAlert(saved.id);
    publish({ type: 'trading_alert', room: 'trading', alert });
    if (saved.decision.action === 'push' || saved.decision.action === 'quiet') {
      const short = config.tradingNoticeDisclaimer || '';
      publish({
        type: 'trading_notice',
        room: 'trading',
        notice: {
          id: saved.id,
          sound: saved.decision.sound,
          quiet: saved.decision.action === 'quiet',
          text: `${alert.summary} ${short}`.trim(),
        },
      });
    }
    if (saved.decision.action === 'overflow') {
      const notices = listNotices();
      publish({
        type: 'trading_notice',
        room: 'trading',
        notice: {
          digest: true,
          sound: notices.digestSound,
          text: notices.digest,
        },
      });
    }
    return { ok: true, status: 201, alert, tsMs: value.tsMs };
  }

  function acknowledge(userId, alertId) {
    if (!Number.isInteger(alertId) || alertId <= 0) return { ok: false, status: 404, error: 'not_found' };
    const row = db.prepare(`
      SELECT a.*, r.slug AS room_slug
      FROM trading_alerts a
      JOIN rooms r ON r.id = a.room_id
      WHERE a.id = ? AND a.superseded = 0
    `).get(alertId);
    if (!row) return { ok: false, status: 404, error: 'not_found' };
    const member = db.prepare(
      'SELECT role FROM room_members WHERE room_id = ? AND user_id = ?',
    ).get(row.room_id, userId);
    if (!member) return { ok: false, status: 403, error: 'forbidden' };
    const created = new Date(now()).toISOString();
    db.prepare(`
      INSERT INTO trading_alert_acks (alert_id, user_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT(alert_id, user_id) DO NOTHING
    `).run(alertId, userId, created);
    const alert = loadAlert(alertId);
    publish({ type: 'trading_alert', room: row.room_slug, alert });
    return { ok: true, status: 200, alert, roomSlug: row.room_slug };
  }

  return {
    ingest,
    acknowledge,
    listVisible,
    listNotices,
    isSilent,
    pullEnabled,
    noteStats,
    noteStream,
    latestTs,
    present,
    loadAlert,
  };
}

module.exports = { ensureTradingSchema, createTradingAlerts, displayTime };

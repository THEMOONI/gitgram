const { ensurePaperCustodyAccount } = require('../ledger');
const { HARD } = require('./risk');

const INSTRUMENTS = [
  ['BTC', 'crypto', 'USD', 'bitcoin', 5, 10],
  ['ETH', 'crypto', 'USD', 'ethereum', 5, 10],
  ['SOL', 'crypto', 'USD', 'solana', 10, 10],
  ['BNB', 'crypto', 'USD', 'binancecoin', 10, 10],
  ['XRP', 'crypto', 'USD', 'ripple', 20, 10],
];

const DEFAULT_WHITELIST = INSTRUMENTS.map((row) => row[0]);

function bookDdl(prefix, { run }) {
  const runCol = run ? 'run_id INTEGER NOT NULL,' : '';
  const orderUnique = run
    ? 'UNIQUE (run_id, client_order_id)'
    : 'UNIQUE (portfolio_id, client_order_id)';
  const positionUnique = run
    ? 'UNIQUE (run_id, portfolio_id, instrument_id)'
    : 'UNIQUE (portfolio_id, instrument_id)';
  return `
    CREATE TABLE IF NOT EXISTS ${prefix}orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${runCol}
      portfolio_id INTEGER NOT NULL,
      client_order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      instrument_id INTEGER,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      type TEXT NOT NULL CHECK (type IN ('market', 'limit', 'stop')),
      qty_base INTEGER NOT NULL,
      limit_price_micro INTEGER,
      stop_price_micro INTEGER,
      stop_loss_pct INTEGER,
      parent_order_id INTEGER,
      protective INTEGER NOT NULL DEFAULT 0 CHECK (protective IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('new', 'rejected', 'open', 'filled', 'cancelled', 'expired')),
      reject_code TEXT,
      reject_message TEXT,
      time_in_force TEXT NOT NULL DEFAULT 'gtc' CHECK (time_in_force IN ('day', 'gtc')),
      request_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ${orderUnique}
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ${prefix}fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${runCol}
      order_id INTEGER NOT NULL,
      portfolio_id INTEGER NOT NULL,
      price_micro INTEGER NOT NULL,
      qty_base INTEGER NOT NULL,
      fee_micro INTEGER NOT NULL,
      realized_micro INTEGER NOT NULL DEFAULT 0,
      slippage_bps INTEGER NOT NULL,
      price_ts TEXT NOT NULL,
      price_source TEXT NOT NULL,
      filled_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ${prefix}positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${runCol}
      portfolio_id INTEGER NOT NULL,
      instrument_id INTEGER NOT NULL,
      qty_base INTEGER NOT NULL,
      cost_micro INTEGER NOT NULL,
      avg_cost_micro INTEGER NOT NULL,
      high_close_micro INTEGER NOT NULL DEFAULT 0,
      last_mark_micro INTEGER NOT NULL DEFAULT 0,
      opened_at TEXT,
      updated_at TEXT NOT NULL,
      ${positionUnique}
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ${prefix}ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${runCol}
      portfolio_id INTEGER NOT NULL,
      tx_id TEXT NOT NULL,
      account TEXT NOT NULL,
      amount_micro INTEGER NOT NULL CHECK (amount_micro != 0),
      ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ${prefix}equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${runCol}
      portfolio_id INTEGER NOT NULL,
      ts TEXT NOT NULL,
      cash_micro INTEGER NOT NULL,
      positions_value_micro INTEGER NOT NULL,
      equity_micro INTEGER NOT NULL,
      drawdown_bps INTEGER NOT NULL
    ) STRICT;
  `;
}

function appendOnly(table) {
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update
    BEFORE UPDATE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table} is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table} is append-only');
    END;
  `;
}

function ensurePaperSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_risk_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      max_position_pct INTEGER NOT NULL,
      max_open_positions INTEGER NOT NULL,
      max_order_value_pct INTEGER NOT NULL,
      max_trades_per_day INTEGER NOT NULL,
      default_stop_loss_pct INTEGER NOT NULL,
      max_drawdown_pct INTEGER NOT NULL,
      min_cash_pct INTEGER NOT NULL,
      whitelist_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_instruments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL UNIQUE,
      asset_class TEXT NOT NULL,
      quote_ccy TEXT NOT NULL,
      external_id TEXT NOT NULL,
      slippage_bps INTEGER NOT NULL,
      fee_bps INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      agent_label TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
      pause_reason TEXT,
      risk_profile_id INTEGER NOT NULL REFERENCES paper_risk_profiles(id),
      peak_equity_micro INTEGER NOT NULL DEFAULT 0,
      parked_minor INTEGER NOT NULL DEFAULT 0 CHECK (parked_minor >= 0),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS bt_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      strategy_id TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      params_json TEXT NOT NULL,
      universe_json TEXT NOT NULL,
      from_ts TEXT NOT NULL,
      to_ts TEXT NOT NULL,
      starting_micro INTEGER NOT NULL,
      status TEXT NOT NULL,
      metrics_json TEXT,
      result_label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS bt_portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL UNIQUE REFERENCES bt_runs(id),
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
      pause_reason TEXT,
      risk_profile_id INTEGER NOT NULL REFERENCES paper_risk_profiles(id),
      peak_equity_micro INTEGER NOT NULL DEFAULT 0,
      parked_minor INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES paper_portfolios(id),
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE
    ) STRICT;

    ${bookDdl('paper_', { run: false })}
    ${bookDdl('bt_', { run: true })}
    ${appendOnly('paper_ledger_entries')}
    ${appendOnly('bt_ledger_entries')}
    ${appendOnly('paper_fills')}
    ${appendOnly('bt_fills')}
    ${appendOnly('paper_equity_snapshots')}
    ${appendOnly('bt_equity_snapshots')}
    ${appendOnly('paper_audit_log')}
  `);

  const insertInstrument = db.prepare(`
    INSERT INTO paper_instruments (symbol, asset_class, quote_ccy, external_id, slippage_bps, fee_bps, enabled)
    VALUES (?, 'crypto', 'USD', ?, ?, ?, 1)
    ON CONFLICT(symbol) DO NOTHING
  `);
  for (const row of INSTRUMENTS) {
    insertInstrument.run(row[0], row[3], row[4], row[5]);
  }

  const whitelist = JSON.stringify(DEFAULT_WHITELIST);
  db.prepare(`
    INSERT INTO paper_risk_profiles (
      name, max_position_pct, max_open_positions, max_order_value_pct, max_trades_per_day,
      default_stop_loss_pct, max_drawdown_pct, min_cash_pct, whitelist_json
    ) VALUES ('hard-default', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO NOTHING
  `).run(
    HARD.maxPositionPct,
    HARD.maxOpenPositions,
    HARD.maxOrderValuePct,
    HARD.maxTradesPerDay,
    HARD.widestStopLossPct,
    HARD.maxDrawdownPct,
    HARD.minCashPct,
    whitelist,
  );
  db.prepare(`
    INSERT INTO paper_risk_profiles (
      name, max_position_pct, max_open_positions, max_order_value_pct, max_trades_per_day,
      default_stop_loss_pct, max_drawdown_pct, min_cash_pct, whitelist_json
    ) VALUES ('mean-revert', ?, ?, ?, ?, 8, ?, ?, ?)
    ON CONFLICT(name) DO NOTHING
  `).run(
    HARD.maxPositionPct,
    HARD.maxOpenPositions,
    HARD.maxOrderValuePct,
    HARD.maxTradesPerDay,
    HARD.maxDrawdownPct,
    HARD.minCashPct,
    whitelist,
  );
  db.prepare(`
    UPDATE paper_risk_profiles
    SET max_position_pct = MIN(max_position_pct, ?),
        max_open_positions = MIN(max_open_positions, ?),
        max_order_value_pct = MIN(max_order_value_pct, ?)
  `).run(HARD.maxPositionPct, HARD.maxOpenPositions, HARD.maxOrderValuePct);
  ensurePaperCustodyAccount(db);
}

module.exports = {
  INSTRUMENTS,
  DEFAULT_WHITELIST,
  ensurePaperSchema,
};

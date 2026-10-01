// TIFI tables. Append-only for decisions and treasury transfers.
// Portfolio cash still lives in the paper engine; these rows are the TIFI book.

function ensureTifiSchema(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tifi_setup (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      risk_accepted_at TEXT,
      password_salt TEXT,
      password_hash TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_drafts (
      user_id INTEGER NOT NULL REFERENCES users(id),
      slot INTEGER NOT NULL CHECK (slot IN (1, 2, 3)),
      sentence TEXT NOT NULL DEFAULT '',
      config_json TEXT,
      portrait_variant INTEGER NOT NULL DEFAULT 1,
      confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
      PRIMARY KEY (user_id, slot)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_treasury (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      portfolio_id INTEGER NOT NULL,
      weights_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_tigers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      slot INTEGER,
      name TEXT NOT NULL,
      tagline TEXT NOT NULL,
      strategy TEXT NOT NULL CHECK (strategy IN ('breakout', 'trend', 'momentum')),
      params_json TEXT NOT NULL,
      symbols_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
      pause_reason TEXT,
      portfolio_id INTEGER NOT NULL,
      max_leverage REAL NOT NULL,
      max_stop_pct INTEGER NOT NULL,
      daily_loss_pct INTEGER NOT NULL,
      max_trades_per_day INTEGER NOT NULL,
      cooldown_sec INTEGER NOT NULL,
      max_position_pct INTEGER NOT NULL,
      fee_budget_pct INTEGER NOT NULL,
      portrait_variant INTEGER NOT NULL DEFAULT 1,
      allocated_minor INTEGER NOT NULL DEFAULT 0,
      day_utc TEXT,
      day_start_equity_micro INTEGER,
      last_trade_at TEXT,
      rules_text TEXT NOT NULL DEFAULT '',
      venue TEXT NOT NULL DEFAULT 'world',
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      from_ref TEXT NOT NULL,
      to_ref TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      audit_hash TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tiger_id INTEGER NOT NULL,
      ts TEXT NOT NULL,
      bar_ts TEXT NOT NULL,
      model_id TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      probabilities_json TEXT NOT NULL,
      guard_verdict TEXT NOT NULL,
      guard_reasons_json TEXT NOT NULL,
      client_order_id TEXT,
      model_cost_micro INTEGER NOT NULL DEFAULT 0,
      audit_hash TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_runner (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      running INTEGER NOT NULL DEFAULT 0 CHECK (running IN (0, 1)),
      cursor_index INTEGER NOT NULL DEFAULT -1,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_auth_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      failed_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_world_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tiger_id INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell', 'settle')),
      shares_micro INTEGER NOT NULL,
      price_micro INTEGER NOT NULL,
      fee_micro INTEGER NOT NULL,
      cash_delta_micro INTEGER NOT NULL,
      ts TEXT NOT NULL,
      audit_hash TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tifi_world_positions (
      tiger_id INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      shares_micro INTEGER NOT NULL,
      cost_micro INTEGER NOT NULL,
      last_mid_micro INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('open', 'settled')),
      payout_micro INTEGER NOT NULL DEFAULT 0,
      settled_at TEXT,
      title TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tiger_id, market_id, outcome)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_tifi_tigers_user ON tifi_tigers(user_id);
    CREATE INDEX IF NOT EXISTS idx_tifi_world_fills_tiger ON tifi_world_fills(tiger_id, id);
    CREATE INDEX IF NOT EXISTS idx_tifi_world_positions_tiger ON tifi_world_positions(tiger_id, status);
    CREATE INDEX IF NOT EXISTS idx_tifi_decisions_user ON tifi_decisions(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_tifi_transfers_user ON tifi_transfers(user_id, id);

    CREATE TRIGGER IF NOT EXISTS tifi_transfers_no_update
    BEFORE UPDATE ON tifi_transfers
    BEGIN
      SELECT RAISE(ABORT, 'tifi transfers are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS tifi_transfers_no_delete
    BEFORE DELETE ON tifi_transfers
    BEGIN
      SELECT RAISE(ABORT, 'tifi transfers are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS tifi_decisions_no_update
    BEFORE UPDATE ON tifi_decisions
    BEGIN
      SELECT RAISE(ABORT, 'tifi decisions are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS tifi_decisions_no_delete
    BEFORE DELETE ON tifi_decisions
    BEGIN
      SELECT RAISE(ABORT, 'tifi decisions are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS tifi_world_fills_no_update
    BEFORE UPDATE ON tifi_world_fills
    BEGIN
      SELECT RAISE(ABORT, 'tifi world fills are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS tifi_world_fills_no_delete
    BEFORE DELETE ON tifi_world_fills
    BEGIN
      SELECT RAISE(ABORT, 'tifi world fills are append-only');
    END;
  `);
  const columns = db.prepare('PRAGMA table_info(tifi_tigers)').all();
  if (!columns.some((column: any) => column.name === 'venue')) {
    db.exec(`ALTER TABLE tifi_tigers ADD COLUMN venue TEXT NOT NULL DEFAULT 'world'`);
  }
}

module.exports = { ensureTifiSchema };

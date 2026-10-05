const DISCLAIMER = 'DEMO MODE · simulated data · no real money';
const UNIT_LABEL = 'GGT (demo)';
const FAUCET_CODE = 'system:faucet';
const FAUCET_HANDLE = 'gitgram-faucet';
const GRANT_MINOR = 100000;
const MAX_TRANSFER_MINOR = 50000;
const MEMO_MAX = 140;
const GRANT_MEMO = 'Welcome grant for demo wallet';

class LedgerError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.status = status;
  }
}

function formatMinor(minor) {
  if (!Number.isSafeInteger(minor)) {
    throw new LedgerError('invalid_amount', 'Enter a demo amount such as 25.00.');
  }
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const frac = String(abs % 100).padStart(2, '0');
  const whole = Math.floor(abs / 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-' : '') + grouped + '.' + frac;
}

function formatSigned(minor) {
  const body = formatMinor(Math.abs(minor));
  if (minor > 0) return '+' + body;
  if (minor < 0) return '\u2212' + body;
  return body;
}

function amountDisplay(minor) {
  return formatSigned(minor) + ' ' + UNIT_LABEL;
}

function parseAmountToMinor(input) {
  if (typeof input !== 'string') {
    return { ok: false, code: 'invalid_amount', message: 'Enter a demo amount such as 25.00.' };
  }
  const raw = input.trim();
  if (!raw || /[eE+]/.test(raw)) {
    return { ok: false, code: 'invalid_amount', message: 'Enter a demo amount such as 25.00.' };
  }
  let negative = false;
  let body = raw;
  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1);
  }
  if (body.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body)) {
      return { ok: false, code: 'invalid_amount', message: 'Enter a demo amount such as 25.00.' };
    }
    body = body.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(body)) {
    return { ok: false, code: 'invalid_amount', message: 'Enter a demo amount such as 25.00.' };
  }
  const parts = body.split('.');
  const whole = parts[0];
  const frac = parts[1] || '';
  if (frac.length > 2) {
    return {
      ok: false,
      code: 'non_integer_cents',
      message: 'Amount must be a whole number of cents (demo), with at most two decimal places.',
    };
  }
  if (whole.length > 7) {
    return {
      ok: false,
      code: 'too_large',
      message: 'Amount exceeds the maximum of 500.00 GGT (demo) per transfer.',
    };
  }
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(minor)) {
    return {
      ok: false,
      code: 'too_large',
      message: 'Amount exceeds the maximum of 500.00 GGT (demo) per transfer.',
    };
  }
  if (negative) {
    if (minor === 0) {
      return { ok: false, code: 'zero', message: 'Enter an amount greater than 0.00 GGT (demo).' };
    }
    return { ok: false, code: 'negative', message: 'Enter an amount greater than 0.00 GGT (demo). Negative amounts are rejected.' };
  }
  if (minor === 0) {
    return { ok: false, code: 'zero', message: 'Enter an amount greater than 0.00 GGT (demo).' };
  }
  if (minor > MAX_TRANSFER_MINOR) {
    return {
      ok: false,
      code: 'too_large',
      message: 'Amount exceeds the maximum of 500.00 GGT (demo) per transfer.',
    };
  }
  return { ok: true, minor };
}

function normalizeMemo(input) {
  if (input == null || input === '') return { ok: true, memo: '' };
  if (typeof input !== 'string') {
    return { ok: false, code: 'memo_too_long', message: 'Message must be 140 characters or fewer.' };
  }
  const memo = input.replace(/\s+/g, ' ').trim();
  if (memo.length > MEMO_MAX) {
    return { ok: false, code: 'memo_too_long', message: 'Message must be 140 characters or fewer.' };
  }
  return { ok: true, memo };
}

function isIdempotencyKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value) && !value.startsWith('grant:');
}

function ensureLedgerSchema(db) {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'system')),
      user_id INTEGER UNIQUE REFERENCES users(id),
      code TEXT NOT NULL UNIQUE,
      balance_minor INTEGER NOT NULL DEFAULT 0 CHECK (kind = 'system' OR balance_minor >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ledger_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('grant', 'transfer')),
      from_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
      to_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      memo TEXT NOT NULL DEFAULT '',
      actor_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (from_account_id != to_account_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id INTEGER NOT NULL REFERENCES ledger_transfers(id),
      account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
      amount_minor INTEGER NOT NULL CHECK (amount_minor != 0),
      UNIQUE (transfer_id, account_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_transfer ON ledger_entries(transfer_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_transfers_created ON ledger_transfers(created_at);

    CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update
    BEFORE UPDATE ON ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'ledger entries are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete
    BEFORE DELETE ON ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'ledger entries are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_transfers_no_update
    BEFORE UPDATE ON ledger_transfers
    BEGIN
      SELECT RAISE(ABORT, 'ledger transfers are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_transfers_no_delete
    BEFORE DELETE ON ledger_transfers
    BEGIN
      SELECT RAISE(ABORT, 'ledger transfers are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_two_entries
    BEFORE INSERT ON ledger_entries
    WHEN (SELECT COUNT(*) FROM ledger_entries WHERE transfer_id = NEW.transfer_id) >= 2
    BEGIN
      SELECT RAISE(ABORT, 'transfer already balanced');
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_apply_balance
    AFTER INSERT ON ledger_entries
    BEGIN
      UPDATE ledger_accounts
      SET balance_minor = (
        SELECT COALESCE(SUM(amount_minor), 0)
        FROM ledger_entries
        WHERE account_id = NEW.account_id
      )
      WHERE id = NEW.account_id;

      SELECT RAISE(ABORT, 'negative balance')
      WHERE (SELECT kind FROM ledger_accounts WHERE id = NEW.account_id) = 'user'
        AND (SELECT balance_minor FROM ledger_accounts WHERE id = NEW.account_id) < 0;
    END;

    CREATE TRIGGER IF NOT EXISTS ledger_entries_balanced
    AFTER INSERT ON ledger_entries
    WHEN (SELECT COUNT(*) FROM ledger_entries WHERE transfer_id = NEW.transfer_id) = 2
    BEGIN
      SELECT RAISE(ABORT, 'unbalanced transfer')
      WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries WHERE transfer_id = NEW.transfer_id) != 0;
    END;
  `);
  db.prepare(`
    INSERT INTO ledger_accounts (kind, user_id, code, balance_minor)
    VALUES ('system', NULL, ?, 0)
    ON CONFLICT(code) DO NOTHING
  `).run(FAUCET_CODE);
}

function getFaucet(db) {
  return db.prepare('SELECT * FROM ledger_accounts WHERE code = ?').get(FAUCET_CODE);
}

function getAccountByUserId(db, userId) {
  return db.prepare('SELECT * FROM ledger_accounts WHERE user_id = ?').get(userId);
}

function ensureUserAccount(db, userId) {
  db.prepare(`
    INSERT INTO ledger_accounts (kind, user_id, code, balance_minor)
    VALUES ('user', ?, ?, 0)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId, 'user:' + userId);
  return getAccountByUserId(db, userId);
}

function isUniqueConstraint(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  return err.code === 'SQLITE_CONSTRAINT' && /UNIQUE/i.test(err.message || '');
}

function isNegativeBalance(err) {
  if (!err) return false;
  const message = err.message || '';
  return /negative balance/i.test(message) || /CHECK constraint failed/i.test(message);
}

function insufficientMessage(balanceMinor) {
  return 'Amount exceeds your balance of ' + formatMinor(balanceMinor) + ' GGT (demo).';
}

function findTransferByKey(db, key) {
  return db.prepare('SELECT * FROM ledger_transfers WHERE idempotency_key = ?').get(key);
}

function payloadMatches(existing, spec, ids) {
  return existing.kind === spec.kind
    && existing.amount_minor === spec.amountMinor
    && existing.memo === spec.memo
    && existing.from_account_id === ids.fromId
    && existing.to_account_id === ids.toId;
}

function resolveAccountIds(db, spec) {
  if (spec.kind === 'grant') {
    const from = getFaucet(db);
    const to = getAccountByUserId(db, spec.toUserId);
    return { fromId: from ? from.id : null, toId: to ? to.id : null };
  }
  const from = getAccountByUserId(db, spec.fromUserId);
  const to = getAccountByUserId(db, spec.toUserId);
  return { fromId: from ? from.id : null, toId: to ? to.id : null };
}

function assertTransferBalanced(db, transferId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total
    FROM ledger_entries
    WHERE transfer_id = ?
  `).get(transferId);
  if (!row || row.n !== 2 || row.total !== 0) {
    throw new LedgerError('unbalanced', 'Transfer entries must sum to zero.');
  }
}

function insertBalancedTransfer(db, spec, from, to) {
  if (from.id === to.id) {
    throw new LedgerError('self', "You can't send demo tokens to yourself.");
  }
  if (from.kind === 'user' && from.balance_minor < spec.amountMinor) {
    throw new LedgerError('insufficient_funds', insufficientMessage(from.balance_minor));
  }
  const info = db.prepare(`
    INSERT INTO ledger_transfers (
      idempotency_key, kind, from_account_id, to_account_id, amount_minor, memo, actor_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    spec.idempotencyKey,
    spec.kind,
    from.id,
    to.id,
    spec.amountMinor,
    spec.memo,
    spec.actorUserId
  );
  const transferId = Number(info.lastInsertRowid);
  const insertEntry = db.prepare('INSERT INTO ledger_entries (transfer_id, account_id, amount_minor) VALUES (?, ?, ?)');
  insertEntry.run(transferId, from.id, -spec.amountMinor);
  insertEntry.run(transferId, to.id, spec.amountMinor);
  assertTransferBalanced(db, transferId);
  return transferId;
}

function applyTransfer(db, spec) {
  const run = db.transaction(() => {
    const existing = findTransferByKey(db, spec.idempotencyKey);
    if (existing) {
      const ids = resolveAccountIds(db, spec);
      if (!ids.fromId || !ids.toId || !payloadMatches(existing, spec, ids)) {
        throw new LedgerError(
          'idempotency_conflict',
          'This demo transfer was already submitted with different details.',
          409
        );
      }
      return { outcome: 'replayed', transferId: Number(existing.id) };
    }

    if (spec.kind === 'grant') {
      const from = getFaucet(db);
      const to = ensureUserAccount(db, spec.toUserId);
      const transferId = insertBalancedTransfer(db, spec, from, to);
      return { outcome: 'created', transferId };
    }

    if (!Number.isSafeInteger(spec.amountMinor) || spec.amountMinor < 1) {
      throw new LedgerError('invalid_amount', 'Enter a demo amount such as 25.00.');
    }
    if (spec.amountMinor > MAX_TRANSFER_MINOR) {
      throw new LedgerError('too_large', 'Amount exceeds the maximum of 500.00 GGT (demo) per transfer.');
    }
    if (spec.fromUserId === spec.toUserId) {
      throw new LedgerError('self', "You can't send demo tokens to yourself.");
    }
    // The sender's one-time grant is part of this transaction. A later throw rolls it back,
    // so a rejected transfer does not leave a new grant behind.
    issueWelcomeGrant(db, spec.fromUserId);
    const from = getAccountByUserId(db, spec.fromUserId);
    if (!from || from.balance_minor < spec.amountMinor) {
      throw new LedgerError('insufficient_funds', insufficientMessage(from ? from.balance_minor : 0));
    }
    issueWelcomeGrant(db, spec.toUserId);
    const to = getAccountByUserId(db, spec.toUserId);
    const fromNow = getAccountByUserId(db, spec.fromUserId);
    const transferId = insertBalancedTransfer(db, spec, fromNow, to);
    return { outcome: 'created', transferId };
  });

  try {
    return run();
  } catch (err) {
    if (err instanceof LedgerError) throw err;
    if (isUniqueConstraint(err)) {
      const existing = findTransferByKey(db, spec.idempotencyKey);
      if (existing) {
        const ids = resolveAccountIds(db, spec);
        if (ids.fromId && ids.toId && payloadMatches(existing, spec, ids)) {
          return { outcome: 'replayed', transferId: Number(existing.id) };
        }
        throw new LedgerError(
          'idempotency_conflict',
          'This demo transfer was already submitted with different details.',
          409
        );
      }
    }
    if (isNegativeBalance(err)) {
      const from = spec.kind === 'grant' ? getFaucet(db) : getAccountByUserId(db, spec.fromUserId);
      const balance = from ? from.balance_minor : 0;
      throw new LedgerError('insufficient_funds', insufficientMessage(balance));
    }
    throw err;
  }
}

function issueWelcomeGrant(db, userId) {
  return applyTransfer(db, {
    idempotencyKey: 'grant:user:' + userId,
    kind: 'grant',
    toUserId: userId,
    amountMinor: GRANT_MINOR,
    memo: GRANT_MEMO,
    actorUserId: userId,
  });
}

function transferBetweenUsers(db, spec) {
  return applyTransfer(db, {
    idempotencyKey: spec.idempotencyKey,
    kind: 'transfer',
    fromUserId: spec.fromUserId,
    toUserId: spec.toUserId,
    amountMinor: spec.amountMinor,
    memo: spec.memo,
    actorUserId: spec.fromUserId,
  });
}

function normalizeFlow(value) {
  const flow = Array.isArray(value) ? value[0] : value;
  if (flow === 'in' || flow === 'out') return flow;
  return 'all';
}

function readWallet(db, userId, flow) {
  const account = getAccountByUserId(db, userId);
  const selected = normalizeFlow(flow);
  if (!account) {
    return {
      account: null,
      flow: selected,
      balanceMinor: 0,
      received30dMinor: 0,
      sent30dMinor: 0,
      pendingMinor: 0,
      history: [],
    };
  }
  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN e.amount_minor > 0 THEN e.amount_minor ELSE 0 END), 0) AS received,
      COALESCE(SUM(CASE WHEN e.amount_minor < 0 THEN -e.amount_minor ELSE 0 END), 0) AS sent
    FROM ledger_entries e
    JOIN ledger_transfers t ON t.id = e.transfer_id
    WHERE e.account_id = ?
      AND t.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
  `).get(account.id);
  const directionSql = selected === 'in'
    ? 'AND e.amount_minor > 0'
    : selected === 'out'
      ? 'AND e.amount_minor < 0'
      : '';
  const history = db.prepare(`
    SELECT
      t.id,
      t.memo,
      t.kind,
      t.created_at,
      e.amount_minor,
      other.kind AS counterparty_kind,
      other.code AS counterparty_code,
      users.username AS counterparty_username
    FROM ledger_entries e
    JOIN ledger_transfers t ON t.id = e.transfer_id
    JOIN ledger_entries other_entry
      ON other_entry.transfer_id = t.id AND other_entry.account_id != e.account_id
    JOIN ledger_accounts other ON other.id = other_entry.account_id
    LEFT JOIN users ON users.id = other.user_id
    WHERE e.account_id = ?
    ${directionSql}
    ORDER BY t.id DESC
    LIMIT 100
  `).all(account.id);
  return {
    account,
    flow: selected,
    balanceMinor: account.balance_minor,
    received30dMinor: stats.received,
    sent30dMinor: stats.sent,
    pendingMinor: 0,
    history,
  };
}

function getWallet(db, userId, flow) {
  issueWelcomeGrant(db, userId);
  return readWallet(db, userId, flow);
}

function formatTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '');
  const now = new Date();
  const sameDay = (a, b) => a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const hm = date.toISOString().slice(11, 16);
  if (sameDay(date, now)) return 'Today ' + hm;
  if (sameDay(date, yesterday)) return 'Yesterday ' + hm;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return date.getUTCDate() + ' ' + months[date.getUTCMonth()] + ' ' + hm;
}

const AVATAR_COLORS = ['#6CC6FF', '#C8F53B', '#9A8CFF', '#FFB547', '#3DDC97', '#FF5D7A', '#E86BD1', '#F2994A'];

function avatarColor(name) {
  let hash = 0;
  const text = String(name || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function presentEntry(row) {
  const username = row.counterparty_username || FAUCET_HANDLE;
  const incoming = row.amount_minor > 0;
  return {
    id: row.id,
    direction: incoming ? 'in' : 'out',
    directionLabel: incoming ? 'Incoming' : 'Outgoing',
    arrow: incoming ? '\u2193' : '\u2191',
    username,
    isSystem: row.counterparty_kind === 'system',
    memo: row.memo,
    amountMinor: row.amount_minor,
    amountLabel: formatSigned(row.amount_minor),
    amountDisplay: amountDisplay(row.amount_minor),
    when: formatTimestamp(row.created_at),
    createdAt: row.created_at,
    initial: username.charAt(0).toUpperCase(),
    color: row.counterparty_kind === 'system' ? '#C8F53B' : avatarColor(username),
    kind: row.kind,
  };
}

module.exports = {
  DISCLAIMER,
  UNIT_LABEL,
  FAUCET_CODE,
  FAUCET_HANDLE,
  GRANT_MINOR,
  GRANT_MEMO,
  MAX_TRANSFER_MINOR,
  MEMO_MAX,
  LedgerError,
  formatMinor,
  formatSigned,
  amountDisplay,
  parseAmountToMinor,
  normalizeMemo,
  isIdempotencyKey,
  ensureLedgerSchema,
  issueWelcomeGrant,
  transferBetweenUsers,
  getWallet,
  readWallet,
  getAccountByUserId,
  normalizeFlow,
  presentEntry,
  formatTimestamp,
};

const { bindInt, asMicro } = require('./money');

const LIVE = {
  kind: 'live',
  portfolio: 'paper_portfolios',
  order: 'paper_orders',
  fill: 'paper_fills',
  position: 'paper_positions',
  ledger: 'paper_ledger_entries',
  equity: 'paper_equity_snapshots',
};

const BACKTEST = {
  kind: 'backtest',
  portfolio: 'bt_portfolios',
  order: 'bt_orders',
  fill: 'bt_fills',
  position: 'bt_positions',
  ledger: 'bt_ledger_entries',
  equity: 'bt_equity_snapshots',
};

const TABLES = new Set([
  ...Object.values(LIVE).filter((value) => value !== 'live'),
  ...Object.values(BACKTEST).filter((value) => value !== 'backtest'),
  'bt_runs',
]);

function bookFor(kind, runId) {
  if (kind === 'backtest') return { ...BACKTEST, runId };
  return { ...LIVE };
}

function bind(value) {
  if (typeof value === 'bigint') return bindInt(value);
  return value;
}

function insert(db, table, row) {
  if (!TABLES.has(table)) throw new Error('unknown paper table');
  const cols = Object.keys(row).filter((key) => row[key] !== undefined);
  const sql = 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')';
  return db.prepare(sql).run(...cols.map((key) => bind(row[key])));
}

function scoped(book, column) {
  if (book.kind === 'backtest') return column + ' = ? AND run_id = ?';
  return column + ' = ?';
}

function scopeArgs(book, id) {
  if (book.kind === 'backtest') return [id, book.runId];
  return [id];
}

function withRun(book, row) {
  if (book.kind !== 'backtest') return row;
  return { run_id: book.runId, ...row };
}

const ACCOUNT_RE = /^(cash|fees|pnl|wallet|position:[A-Z0-9]{2,12})$/;

function postLedger(db, book, portfolioId, txId, entries, refType, refId, ts) {
  let sum = 0n;
  const cleaned = [];
  for (const entry of entries) {
    const amount = asMicro(entry.amount);
    if (amount === 0n) continue;
    if (!ACCOUNT_RE.test(entry.account)) throw new Error('bad ledger account');
    sum += amount;
    cleaned.push({ account: entry.account, amount });
  }
  if (cleaned.length < 2 || sum !== 0n) {
    throw new Error('unbalanced paper ledger transaction');
  }
  for (const entry of cleaned) {
    insert(db, book.ledger, withRun(book, {
      portfolio_id: portfolioId,
      tx_id: txId,
      account: entry.account,
      amount_micro: entry.amount,
      ref_type: refType,
      ref_id: String(refId),
      created_at: ts,
    }));
  }
}

function sumAccount(db, book, portfolioId, account) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(amount_micro), 0) AS total FROM ' + book.ledger
    + ' WHERE ' + scoped(book, 'portfolio_id') + ' AND account = ?'
  ).get(...scopeArgs(book, portfolioId), account);
  return asMicro(row.total);
}

function ledgerReport(db, book, portfolioId) {
  const where = portfolioId == null ? '' : ' WHERE ' + scoped(book, 'portfolio_id');
  const args = portfolioId == null ? [] : scopeArgs(book, portfolioId);
  const total = db.prepare('SELECT COALESCE(SUM(amount_micro), 0) AS total FROM ' + book.ledger + where).get(...args);
  const txs = db.prepare(
    'SELECT tx_id, COALESCE(SUM(amount_micro), 0) AS total, COUNT(*) AS n FROM ' + book.ledger
    + where + ' GROUP BY tx_id'
  ).all(...args);
  return { total: asMicro(total.total), txs };
}

module.exports = {
  LIVE,
  BACKTEST,
  bookFor,
  insert,
  scoped,
  scopeArgs,
  withRun,
  postLedger,
  sumAccount,
  ledgerReport,
};

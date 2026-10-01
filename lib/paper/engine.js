const crypto = require('crypto');
const {
  ensurePaperCustodyAccount,
  issueWelcomeGrant,
  getAccountByUserId,
  transferBetweenAccounts,
  isIdempotencyKey,
  LedgerError,
} = require('../ledger');
const { appendAudit } = require('./audit');
const { marketFill, limitFill, stopFill, feeFor, notionalMicro } = require('./fills');
const { evaluateOrder, message, validateProfile } = require('./risk');
const { DEFAULT_WHITELIST } = require('./schema');
const {
  asMicro,
  bindInt,
  minorToMicro,
  microToMinorFloor,
  QTY_SCALE,
  drawdownBps,
  formatMicro,
  formatQty,
  parseDecimalToScaled,
} = require('./money');
const {
  bookFor,
  insert,
  postLedger,
  sumAccount,
  withRun,
  ledgerReport,
} = require('./ledgerbook');

const MAX_PRICE_AGE_MS = 15 * 60 * 1000;

class PaperError extends Error {
  constructor(code, msg, status = 400) {
    super(msg || message(code));
    this.name = 'PaperError';
    this.code = code;
    this.status = status;
  }
}

function iso(clock) {
  const date = clock ? clock() : new Date();
  return date.toISOString();
}

function utcDay(value) {
  return String(value || '').slice(0, 10);
}

function actorParts(actor) {
  if (actor && actor.type === 'agent') return { actorType: 'agent', actorId: actor.id };
  if (actor && actor.type === 'user') return { actorType: 'user', actorId: actor.id };
  return { actorType: 'system', actorId: 'system:engine' };
}

function audit(db, book, actor, action, payload, ts) {
  if (!book || book.kind !== 'live') return;
  const who = actorParts(actor);
  appendAudit(db, { ts, actorType: who.actorType, actorId: who.actorId, action, payload });
}

function pfWhere(book, alias) {
  const p = alias ? alias + '.' : '';
  if (book.kind === 'backtest') return p + 'portfolio_id = ? AND ' + p + 'run_id = ?';
  return p + 'portfolio_id = ?';
}

function pfArgs(book, id) {
  return book.kind === 'backtest' ? [id, book.runId] : [id];
}

function requirePortfolio(db, book, id, actor) {
  const row = db.prepare('SELECT * FROM ' + book.portfolio + ' WHERE id = ?').get(id);
  if (!row || (book.kind === 'backtest' && row.run_id !== book.runId)) {
    throw new PaperError('NOT_FOUND', 'Portföljen finns inte.', 404);
  }
  if (actor && actor.type === 'agent' && actor.portfolioId !== row.id) {
    throw new PaperError('FORBIDDEN', 'Agentnyckeln gäller en annan portfölj.', 403);
  }
  if (actor && actor.type === 'user' && row.owner_user_id !== actor.userId) {
    throw new PaperError('FORBIDDEN', 'Den portföljen tillhör en annan användare.', 403);
  }
  return row;
}

function loadProfile(db, id) {
  const row = db.prepare('SELECT * FROM paper_risk_profiles WHERE id = ?').get(id);
  if (!row) throw new PaperError('NOT_FOUND', 'Riskprofilen finns inte.', 404);
  row.whitelist = JSON.parse(row.whitelist_json);
  return row;
}

function loadInstrument(db, symbol) {
  if (!symbol) return null;
  return db.prepare('SELECT * FROM paper_instruments WHERE symbol = ?').get(String(symbol).toUpperCase());
}

function listInstruments(db) {
  return db.prepare('SELECT symbol, asset_class, quote_ccy, slippage_bps, fee_bps, enabled FROM paper_instruments ORDER BY symbol').all();
}

function positionMap(db, book, portfolioId) {
  const rows = db.prepare(`
    SELECT p.*, i.symbol
    FROM ${book.position} p
    JOIN paper_instruments i ON i.id = p.instrument_id
    WHERE ${pfWhere(book, 'p')}
  `).all(...pfArgs(book, portfolioId));
  const map = new Map();
  for (const row of rows) {
    map.set(row.symbol, {
      ...row,
      qtyMicro: asMicro(row.qty_base),
      costMicro: asMicro(row.cost_micro),
    });
  }
  return map;
}

function countOpenPositions(map) {
  let n = 0;
  for (const pos of map.values()) if (pos.qtyMicro > 0n) n += 1;
  return n;
}

function tradesToday(db, book, portfolioId, day) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM ${book.fill} f
    JOIN ${book.order} o ON o.id = f.order_id
    WHERE ${pfWhere(book, 'f')} AND o.protective = 0 AND substr(f.filled_at, 1, 10) = ?
  `).get(...pfArgs(book, portfolioId), day);
  return row.n;
}

function canonicalOrder(order) {
  const body = {
    symbol: String(order.symbol || '').toUpperCase(),
    side: order.side,
    type: order.type,
    qty: order.qty == null ? null : String(order.qty),
    notionalPct: order.notionalPct == null && order.notional_pct == null
      ? null
      : Number(order.notionalPct ?? order.notional_pct),
    sellAll: !!(order.sellAll || order.sell_all),
    limitPrice: order.limitPrice == null && order.limit_price == null ? null : String(order.limitPrice ?? order.limit_price),
    stopPrice: order.stopPrice == null && order.stop_price == null ? null : String(order.stopPrice ?? order.stop_price),
    stopLossPct: order.stopLossPct == null && order.stop_loss_pct == null
      ? null
      : Number(order.stopLossPct ?? order.stop_loss_pct),
    timeInForce: order.timeInForce || order.time_in_force || 'gtc',
  };
  const { stableStringify } = require('./audit');
  return stableStringify(body);
}

function costsFor(instrument, costs) {
  const mul = costs && costs.doubleCosts ? 2 : 1;
  const fee = costs && costs.feeBps != null ? Number(costs.feeBps) : instrument.fee_bps;
  const slip = costs && costs.slippageBps != null ? Number(costs.slippageBps) : instrument.slippage_bps;
  return { feeBps: fee * mul, slippageBps: slip * mul };
}

function priceFresh(ts, clock, maxAge) {
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return false;
  const age = (clock ? clock() : new Date()).getTime() - at;
  return age >= -60000 && age <= (maxAge == null ? MAX_PRICE_AGE_MS : maxAge);
}

function clientIdOf(order) {
  return String(order.clientOrderId || order.client_order_id || '');
}

function resolveProfileId(db, preset, risk) {
  const name = preset || 'hard-default';
  if (!risk) {
    const row = db.prepare('SELECT id FROM paper_risk_profiles WHERE name = ?').get(name);
    if (!row) throw new PaperError('INVALID_ORDER', 'Okänd riskprofil.');
    return row.id;
  }
  const checked = validateProfile(risk, DEFAULT_WHITELIST);
  if (!checked.ok) throw new PaperError(checked.code, checked.message);
  const info = db.prepare(`
    INSERT INTO paper_risk_profiles (
      name, max_position_pct, max_open_positions, max_order_value_pct, max_trades_per_day,
      default_stop_loss_pct, max_drawdown_pct, min_cash_pct, whitelist_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'custom-' + crypto.randomBytes(8).toString('hex'),
    checked.risk.max_position_pct,
    checked.risk.max_open_positions,
    checked.risk.max_order_value_pct,
    checked.risk.max_trades_per_day,
    checked.risk.default_stop_loss_pct,
    checked.risk.max_drawdown_pct,
    checked.risk.min_cash_pct,
    JSON.stringify(checked.whitelist)
  );
  return Number(info.lastInsertRowid);
}

function createPortfolio(db, args) {
  const book = args.book || bookFor('live');
  const ts = iso(args.clock);
  const profileId = resolveProfileId(db, args.preset, args.risk);
  const row = withRun(book, {
    owner_user_id: args.userId,
    status: 'active',
    pause_reason: null,
    risk_profile_id: profileId,
    peak_equity_micro: 0,
    parked_minor: 0,
    created_at: ts,
  });
  if (book.kind === 'live') row.agent_label = args.agentLabel || null;
  const info = insert(db, book.portfolio, row);
  const id = Number(info.lastInsertRowid);
  audit(db, book, args.actor || { type: 'user', id: 'user:' + args.userId }, 'portfolio_create', {
    portfolioId: id,
    preset: args.preset || 'hard-default',
  }, ts);
  return id;
}

function equityFrom(db, book, portfolioId, marks) {
  const cash = sumAccount(db, book, portfolioId, 'cash');
  const positions = positionMap(db, book, portfolioId);
  let positionsValue = 0n;
  for (const pos of positions.values()) {
    if (pos.qtyMicro <= 0n) continue;
    const marked = marks && marks[pos.symbol] != null
      ? asMicro(marks[pos.symbol])
      : asMicro(pos.last_mark_micro || pos.avg_cost_micro);
    positionsValue += notionalMicro(marked, pos.qtyMicro);
  }
  return { cash, positionsValue, equity: cash + positionsValue, positions };
}

function writeSnapshot(db, book, portfolio, marks, ts, actor, options = {}) {
  const view = equityFrom(db, book, portfolio.id, marks);
  if (marks) {
    const update = db.prepare(`
      UPDATE ${book.position}
      SET last_mark_micro = ?, high_close_micro = ?, updated_at = ?
      WHERE id = ?
    `);
    for (const pos of view.positions.values()) {
      if (marks[pos.symbol] == null || pos.qtyMicro <= 0n) continue;
      const mark = asMicro(marks[pos.symbol]);
      const high = mark > asMicro(pos.high_close_micro) ? mark : asMicro(pos.high_close_micro);
      update.run(bindInt(mark), bindInt(high), ts, pos.id);
    }
  }
  let peak = asMicro(portfolio.peak_equity_micro);
  if (view.equity > peak) peak = view.equity;
  const dd = drawdownBps(peak, view.equity);
  db.prepare('UPDATE ' + book.portfolio + ' SET peak_equity_micro = ? WHERE id = ?')
    .run(bindInt(peak), portfolio.id);
  insert(db, book.equity, withRun(book, {
    portfolio_id: portfolio.id,
    ts,
    cash_micro: view.cash,
    positions_value_micro: view.positionsValue,
    equity_micro: view.equity,
    drawdown_bps: dd,
  }));
  const profile = loadProfile(db, portfolio.risk_profile_id);
  const tripped = options.enforceKill !== false
    && portfolio.status === 'active'
    && dd >= BigInt(profile.max_drawdown_pct) * 100n;
  if (tripped) {
    db.prepare(`
      UPDATE ${book.portfolio}
      SET status = 'paused', pause_reason = 'drawdown', peak_equity_micro = ?
      WHERE id = ?
    `).run(bindInt(peak), portfolio.id);
    const runSql = book.kind === 'backtest' ? ' AND run_id = ?' : '';
    const args = [portfolio.id];
    if (book.kind === 'backtest') args.push(book.runId);
    db.prepare(`
      UPDATE ${book.order}
      SET status = 'cancelled'
      WHERE portfolio_id = ?${runSql} AND status = 'open' AND side = 'buy'
    `).run(...args);
    audit(db, book, { type: 'system', id: 'system:kill-switch' }, 'kill_switch', {
      portfolioId: portfolio.id,
      drawdownBps: dd.toString(),
      equity: formatMicro(view.equity),
      message: message('KILL_SWITCH'),
    }, ts);
  }
  return { ...view, drawdownBps: dd, tripped, peak };
}

function allocate(db, args) {
  if (!isIdempotencyKey(args.idempotencyKey)) {
    throw new PaperError('INVALID_ORDER', 'Ogiltig idempotensnyckel.');
  }
  const book = bookFor('live');
  const ts = iso(args.clock);
  return db.transaction(() => {
    const portfolio = requirePortfolio(db, book, args.portfolioId, args.actor);
    issueWelcomeGrant(db, portfolio.owner_user_id);
    const user = getAccountByUserId(db, portfolio.owner_user_id);
    const custody = ensurePaperCustodyAccount(db);
    if (!user || user.balance_minor < args.amountMinor) {
      throw new PaperError('INSUFFICIENT_CASH', 'Plånbokens saldo räcker inte till allokeringen.');
    }
    const already = db.prepare('SELECT portfolio_id FROM paper_ledger_entries WHERE tx_id = ? LIMIT 1')
      .get('alloc:' + args.idempotencyKey);
    if (already && already.portfolio_id !== portfolio.id) {
      throw new PaperError('IDEMPOTENCY_CONFLICT', message('IDEMPOTENCY_CONFLICT'), 409);
    }
    const moved = transferBetweenAccounts(db, {
      idempotencyKey: args.idempotencyKey,
      fromAccountId: user.id,
      toAccountId: custody.id,
      amountMinor: args.amountMinor,
      memo: 'Paper portfolio allocation (demo)',
      actorUserId: portfolio.owner_user_id,
      skipMax: true,
    });
    if (already || moved.outcome === 'replayed') return readState(db, portfolio.id);
    const micro = minorToMicro(args.amountMinor);
    postLedger(db, book, portfolio.id, 'alloc:' + args.idempotencyKey, [
      { account: 'wallet', amount: -micro },
      { account: 'cash', amount: micro },
    ], 'allocation', args.idempotencyKey, ts);
    db.prepare('UPDATE paper_portfolios SET parked_minor = parked_minor + ? WHERE id = ?')
      .run(args.amountMinor, portfolio.id);
    const fresh = requirePortfolio(db, book, portfolio.id, null);
    writeSnapshot(db, book, fresh, null, ts, args.actor, { enforceKill: false });
    audit(db, book, args.actor, 'allocate', {
      portfolioId: portfolio.id,
      amount: formatMicro(micro),
      unit: 'GGT (demo)',
    }, ts);
    return readState(db, portfolio.id);
  })();
}

function withdraw(db, args) {
  if (!isIdempotencyKey(args.idempotencyKey)) {
    throw new PaperError('INVALID_ORDER', 'Ogiltig idempotensnyckel.');
  }
  const book = bookFor('live');
  const ts = iso(args.clock);
  return db.transaction(() => {
    const portfolio = requirePortfolio(db, book, args.portfolioId, args.actor);
    const cash = sumAccount(db, book, portfolio.id, 'cash');
    const cashMinor = Number(microToMinorFloor(cash));
    if (args.amountMinor > cashMinor) {
      throw new PaperError('INSUFFICIENT_CASH', 'Kassan räcker inte till uttaget.');
    }
    if (args.amountMinor > portfolio.parked_minor) {
      throw new PaperError('WITHDRAW_LIMIT', message('WITHDRAW_LIMIT'));
    }
    const user = getAccountByUserId(db, portfolio.owner_user_id);
    const custody = ensurePaperCustodyAccount(db);
    const old = equityFrom(db, book, portfolio.id, null);
    const already = db.prepare('SELECT portfolio_id FROM paper_ledger_entries WHERE tx_id = ? LIMIT 1')
      .get('withdraw:' + args.idempotencyKey);
    if (already && already.portfolio_id !== portfolio.id) {
      throw new PaperError('IDEMPOTENCY_CONFLICT', message('IDEMPOTENCY_CONFLICT'), 409);
    }
    const moved = transferBetweenAccounts(db, {
      idempotencyKey: args.idempotencyKey,
      fromAccountId: custody.id,
      toAccountId: user.id,
      amountMinor: args.amountMinor,
      memo: 'Paper portfolio withdrawal (demo)',
      actorUserId: portfolio.owner_user_id,
      skipMax: true,
    });
    if (already || moved.outcome === 'replayed') return readState(db, portfolio.id);
    const micro = minorToMicro(args.amountMinor);
    postLedger(db, book, portfolio.id, 'withdraw:' + args.idempotencyKey, [
      { account: 'cash', amount: -micro },
      { account: 'wallet', amount: micro },
    ], 'withdrawal', args.idempotencyKey, ts);
    db.prepare('UPDATE paper_portfolios SET parked_minor = parked_minor - ? WHERE id = ?')
      .run(args.amountMinor, portfolio.id);
    const next = equityFrom(db, book, portfolio.id, null);
    let peak = asMicro(portfolio.peak_equity_micro);
    if (old.equity > 0n) peak = peak * next.equity / old.equity;
    if (next.equity > peak) peak = next.equity;
    db.prepare('UPDATE paper_portfolios SET peak_equity_micro = ? WHERE id = ?').run(bindInt(peak), portfolio.id);
    const fresh = requirePortfolio(db, book, portfolio.id, null);
    writeSnapshot(db, book, fresh, null, ts, args.actor, { enforceKill: false });
    audit(db, book, args.actor, 'withdraw', {
      portfolioId: portfolio.id,
      amount: formatMicro(micro),
      unit: 'GGT (demo)',
    }, ts);
    return readState(db, portfolio.id);
  })();
}

function parseOrderPrices(order) {
  const limitRaw = order.limitPrice ?? order.limit_price;
  const stopRaw = order.stopPrice ?? order.stop_price;
  const limit = limitRaw == null || limitRaw === '' ? null : parseDecimalToScaled(String(limitRaw), 6);
  const stop = stopRaw == null || stopRaw === '' ? null : parseDecimalToScaled(String(stopRaw), 6);
  let qtyBase = null;
  if (order.qty != null && order.qty !== '') {
    qtyBase = parseDecimalToScaled(String(order.qty), 6);
    if (qtyBase == null) qtyBase = -1n;
  }
  return { limit, stop, qtyBase };
}

function acceptIntent(db, args) {
  const book = args.book || bookFor('live');
  const order = args.order || {};
  const clientId = clientIdOf(order);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$/.test(clientId)) {
    throw new PaperError('INVALID_ORDER', message('INVALID_ORDER'));
  }
  const canonical = canonicalOrder(order);
  const ts = iso(args.clock);
  let rejected = null;
  const stored = db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM ${book.order}
      WHERE client_order_id = ? AND ${pfWhere(book, '')}
    `.replace('AND portfolio_id', 'AND portfolio_id')).get(clientId, ...pfArgs(book, args.portfolioId));
    if (existing) {
      if (existing.request_json !== canonical) {
        throw new PaperError('IDEMPOTENCY_CONFLICT', message('IDEMPOTENCY_CONFLICT'), 409);
      }
      return { replayed: true, order: existing };
    }
    const portfolio = requirePortfolio(db, book, args.portfolioId, args.actor);
    const profile = loadProfile(db, portfolio.risk_profile_id);
    const symbol = String(order.symbol || '').toUpperCase();
    const instrument = loadInstrument(db, symbol);
    const positions = positionMap(db, book, portfolio.id);
    const position = instrument ? positions.get(instrument.symbol) || null : null;
    const prices = parseOrderPrices(order);
    if (prices.qtyBase != null && prices.qtyBase < 0n) throw new PaperError('INVALID_ORDER', message('INVALID_ORDER'));
    if ((order.limitPrice != null || order.limit_price != null) && prices.limit == null) {
      throw new PaperError('INVALID_ORDER', message('INVALID_ORDER'));
    }
    if ((order.stopPrice != null || order.stop_price != null) && prices.stop == null && order.type === 'stop') {
      throw new PaperError('INVALID_ORDER', message('INVALID_ORDER'));
    }
    const ref = args.quote ? asMicro(args.quote.priceMicro) : null;
    const fresh = args.priceFresh != null
      ? args.priceFresh
      : !!(args.quote && priceFresh(args.quote.ts, args.clock, args.maxPriceAgeMs));
    const costs = instrument ? costsFor(instrument, args.costs) : { feeBps: 10, slippageBps: 10 };
    const view = equityFrom(db, book, portfolio.id, ref && instrument ? { [instrument.symbol]: ref } : null);
    const decision = evaluateOrder({
      portfolioStatus: portfolio.status,
      instrument: instrument ? { ...instrument, enabled: instrument.enabled ? 1 : 0, symbol: instrument.symbol } : null,
      whitelist: profile.whitelist,
      profile,
      side: order.side,
      type: order.type,
      qtyBase: prices.qtyBase,
      notionalPct: order.notionalPct ?? order.notional_pct,
      sellAll: !!(order.sellAll || order.sell_all),
      limitPriceMicro: prices.limit,
      stopPriceMicro: prices.stop,
      stopLossPct: order.stopLossPct ?? order.stop_loss_pct,
      cashMicro: view.cash,
      equityMicro: view.equity > 0n ? view.equity : view.cash,
      position,
      openPositions: countOpenPositions(positions),
      tradesToday: tradesToday(db, book, portfolio.id, utcDay(ts)),
      priceFresh: fresh,
      refPriceMicro: ref,
      isProtectiveStop: !!order.protective,
      slippageBps: costs.slippageBps,
      feeBps: costs.feeBps,
    });
    const side = order.side === 'sell' ? 'sell' : 'buy';
    const type = order.type === 'limit' || order.type === 'stop' || order.type === 'market' ? order.type : 'market';
    const base = withRun(book, {
      portfolio_id: portfolio.id,
      client_order_id: clientId,
      symbol: symbol || 'UNKNOWN',
      instrument_id: instrument ? instrument.id : null,
      side,
      type,
      qty_base: decision.ok ? decision.qtyBase : (prices.qtyBase && prices.qtyBase > 0n ? prices.qtyBase : 1n),
      limit_price_micro: prices.limit,
      stop_price_micro: prices.stop,
      stop_loss_pct: decision.ok ? decision.stopLossPct : null,
      parent_order_id: order.parentOrderId || null,
      protective: order.protective ? 1 : 0,
      status: decision.ok ? 'open' : 'rejected',
      reject_code: decision.ok ? null : decision.code,
      reject_message: decision.ok ? null : decision.message,
      time_in_force: order.timeInForce === 'day' || order.time_in_force === 'day' ? 'day' : 'gtc',
      request_json: canonical,
      created_at: ts,
    });
    if (!instrument || !decision.ok) {
      base.status = 'rejected';
      base.reject_code = instrument ? decision.code : 'NOT_WHITELISTED';
      base.reject_message = instrument ? decision.message : message('NOT_WHITELISTED');
      if (!decision.ok || !instrument) {
        const qty = asMicro(base.qty_base);
        base.qty_base = qty > 0n ? qty : 1n;
      }
    }
    const info = insert(db, book.order, base);
    const saved = db.prepare('SELECT * FROM ' + book.order + ' WHERE id = ?').get(Number(info.lastInsertRowid));
    audit(db, book, args.actor, decision.ok && instrument ? 'order_accept' : 'order_reject', {
      portfolioId: portfolio.id,
      orderId: saved.id,
      clientOrderId: clientId,
      code: saved.reject_code,
      message: saved.reject_message,
      symbol: symbol || null,
    }, ts);
    if (saved.status === 'rejected') {
      rejected = { code: saved.reject_code, message: saved.reject_message, order: saved };
      return { ok: false, order: saved, code: saved.reject_code, message: saved.reject_message };
    }
    return { ok: true, order: saved, decision };
  })();
  if (stored && stored.replayed) return stored;
  if (rejected && args.throwOnReject !== false) {
    const err = new PaperError(rejected.code, rejected.message);
    err.order = rejected.order;
    throw err;
  }
  return stored;
}

function openOrders(db, book, portfolioId) {
  return db.prepare(`
    SELECT o.*, i.symbol, i.slippage_bps, i.fee_bps
    FROM ${book.order} o
    JOIN paper_instruments i ON i.id = o.instrument_id
    WHERE o.status = 'open' AND ${pfWhere(book, 'o')}
  `).all(...pfArgs(book, portfolioId));
}

function bookFill(db, book, portfolio, order, fill, actor) {
  const qty = asMicro(fill.qtyBase);
  const price = asMicro(fill.priceMicro);
  const notion = notionalMicro(price, qty);
  const fee = feeFor(notion, fill.feeBps);
  const positions = positionMap(db, book, portfolio.id);
  const pos = positions.get(order.symbol);
  const ts = fill.filledAt;
  if (order.side === 'buy') {
    const cash = sumAccount(db, book, portfolio.id, 'cash');
    if (notion + fee > cash) {
      db.prepare(`UPDATE ${book.order} SET status = 'rejected', reject_code = 'INSUFFICIENT_CASH', reject_message = ? WHERE id = ?`)
        .run(message('INSUFFICIENT_CASH'), order.id);
      return null;
    }
    postLedger(db, book, portfolio.id, 'fill:' + order.id, [
      { account: 'cash', amount: -(notion + fee) },
      { account: 'position:' + order.symbol, amount: notion },
      { account: 'fees', amount: fee },
    ], 'fill', order.id, ts);
    const prevQty = pos ? pos.qtyMicro : 0n;
    const prevCost = pos ? pos.costMicro : 0n;
    const nextQty = prevQty + qty;
    const nextCost = prevCost + notion;
    const avg = nextCost * QTY_SCALE / nextQty;
    if (!pos) {
      insert(db, book.position, withRun(book, {
        portfolio_id: portfolio.id,
        instrument_id: order.instrument_id,
        qty_base: nextQty,
        cost_micro: nextCost,
        avg_cost_micro: avg,
        high_close_micro: price,
        last_mark_micro: price,
        opened_at: ts,
        updated_at: ts,
      }));
    } else {
      const high = price > asMicro(pos.high_close_micro) ? price : asMicro(pos.high_close_micro);
      db.prepare(`
        UPDATE ${book.position}
        SET qty_base = ?, cost_micro = ?, avg_cost_micro = ?, high_close_micro = ?, last_mark_micro = ?, updated_at = ?
        WHERE id = ?
      `).run(bindInt(nextQty), bindInt(nextCost), bindInt(avg), bindInt(high), bindInt(price), ts, pos.id);
    }
    const fillInfo = insert(db, book.fill, withRun(book, {
      order_id: order.id,
      portfolio_id: portfolio.id,
      price_micro: price,
      qty_base: qty,
      fee_micro: fee,
      realized_micro: 0,
      slippage_bps: fill.slippageBps,
      price_ts: fill.priceTs,
      price_source: fill.priceSource,
      filled_at: ts,
    }));
    db.prepare(`UPDATE ${book.order} SET status = 'filled', qty_base = ? WHERE id = ?`).run(bindInt(qty), order.id);
    const stopPct = order.stop_loss_pct;
    if (stopPct) {
      const stopPrice = price * BigInt(100 - stopPct) / 100n;
      insert(db, book.order, withRun(book, {
        portfolio_id: portfolio.id,
        client_order_id: 'stop-order-' + order.id,
        symbol: order.symbol,
        instrument_id: order.instrument_id,
        side: 'sell',
        type: 'stop',
        qty_base: qty,
        limit_price_micro: null,
        stop_price_micro: stopPrice,
        stop_loss_pct: null,
        parent_order_id: order.id,
        protective: 1,
        status: 'open',
        reject_code: null,
        reject_message: null,
        time_in_force: 'gtc',
        request_json: '{"protective":true}',
        created_at: ts,
      }));
    }
    audit(db, book, actor, 'order_fill', {
      portfolioId: portfolio.id,
      orderId: order.id,
      symbol: order.symbol,
      side: 'buy',
      qty: formatQty(qty),
      price: formatMicro(price, 6),
      fee: formatMicro(fee, 6),
      source: fill.priceSource,
    }, ts);
    return { id: Number(fillInfo.lastInsertRowid), priceMicro: price, qtyBase: qty, feeMicro: fee };
  }

  if (!pos || qty > pos.qtyMicro) {
    db.prepare(`UPDATE ${book.order} SET status = 'rejected', reject_code = 'NO_SHORTING', reject_message = ? WHERE id = ?`)
      .run(message('NO_SHORTING'), order.id);
    return null;
  }
  const removed = pos.costMicro * qty / pos.qtyMicro;
  const realized = notion - removed - fee;
  postLedger(db, book, portfolio.id, 'fill:' + order.id, [
    { account: 'cash', amount: notion - fee },
    { account: 'position:' + order.symbol, amount: -removed },
    { account: 'fees', amount: fee },
    { account: 'pnl', amount: removed - notion },
  ], 'fill', order.id, ts);
  const nextQty = pos.qtyMicro - qty;
  const nextCost = pos.costMicro - removed;
  const avg = nextQty > 0n ? nextCost * QTY_SCALE / nextQty : 0n;
  db.prepare(`
    UPDATE ${book.position}
    SET qty_base = ?, cost_micro = ?, avg_cost_micro = ?, updated_at = ?
    WHERE id = ?
  `).run(bindInt(nextQty), bindInt(nextCost), bindInt(avg), ts, pos.id);
  const fillInfo = insert(db, book.fill, withRun(book, {
    order_id: order.id,
    portfolio_id: portfolio.id,
    price_micro: price,
    qty_base: qty,
    fee_micro: fee,
    realized_micro: realized,
    slippage_bps: fill.slippageBps,
    price_ts: fill.priceTs,
    price_source: fill.priceSource,
    filled_at: ts,
  }));
  db.prepare(`UPDATE ${book.order} SET status = 'filled' WHERE id = ?`).run(order.id);
  if (nextQty === 0n) {
    const runSql = book.kind === 'backtest' ? ' AND run_id = ?' : '';
    const args = [portfolio.id, order.instrument_id, order.id];
    if (book.kind === 'backtest') args.push(book.runId);
    db.prepare(`
      UPDATE ${book.order}
      SET status = 'cancelled'
      WHERE portfolio_id = ? AND instrument_id = ? AND status = 'open' AND side = 'sell' AND id != ?${runSql}
    `).run(...args);
  }
  audit(db, book, actor, 'order_fill', {
    portfolioId: portfolio.id,
    orderId: order.id,
    symbol: order.symbol,
    side: 'sell',
    qty: formatQty(qty),
    price: formatMicro(price, 6),
    fee: formatMicro(fee, 6),
    source: fill.priceSource,
  }, ts);
  return { id: Number(fillInfo.lastInsertRowid), priceMicro: price, qtyBase: qty, feeMicro: fee, realizedMicro: realized };
}

function fillPrice(order, bar, costs) {
  if (order.type === 'market') return marketFill(bar.openMicro, order.side, costs.slippageBps);
  if (order.type === 'limit') return limitFill(bar, order.side, order.limit_price_micro);
  if (order.type === 'stop') return stopFill(bar, order.stop_price_micro, costs.slippageBps);
  return null;
}

function tryFillOrder(db, book, portfolio, order, bar, actor, costs) {
  if (portfolio.status === 'paused' && order.side === 'buy') return null;
  if (!order.protective && tradesToday(db, book, portfolio.id, utcDay(bar.ts)) >= loadProfile(db, portfolio.risk_profile_id).max_trades_per_day) {
    return null;
  }
  const price = fillPrice(order, bar, costs);
  if (price == null) return null;
  return bookFill(db, book, portfolio, order, {
    priceMicro: price,
    qtyBase: order.qty_base,
    feeBps: costs.feeBps,
    slippageBps: order.type === 'limit' ? 0 : costs.slippageBps,
    priceTs: bar.ts,
    priceSource: bar.source || 'feed',
    filledAt: bar.ts,
  }, actor);
}

function onBars(db, args) {
  const book = args.book || bookFor('live');
  const ts = args.barTs || iso(args.clock);
  return db.transaction(() => {
    let portfolio = requirePortfolio(db, book, args.portfolioId, args.actor || null);
    const orders = openOrders(db, book, portfolio.id);
    for (const order of orders) {
      const bar = args.barsBySymbol && args.barsBySymbol[order.symbol];
      if (!bar) continue;
      const instrument = { fee_bps: order.fee_bps, slippage_bps: order.slippage_bps };
      const costs = costsFor(instrument, args.costs);
      tryFillOrder(db, book, portfolio, order, { ...bar, source: bar.source || args.priceSource || 'feed' }, args.actor, costs);
      portfolio = requirePortfolio(db, book, portfolio.id, null);
    }
    const marks = {};
    for (const [symbol, bar] of Object.entries(args.barsBySymbol || {})) marks[symbol] = bar.closeMicro;
    const snap = writeSnapshot(db, book, portfolio, marks, ts, args.actor, { enforceKill: true });
    const day = utcDay(ts);
    const runSql = book.kind === 'backtest' ? ' AND run_id = ?' : '';
    const expireArgs = [day, portfolio.id];
    if (book.kind === 'backtest') expireArgs.push(book.runId);
    db.prepare(`
      UPDATE ${book.order}
      SET status = 'expired'
      WHERE status = 'open' AND time_in_force = 'day' AND substr(created_at, 1, 10) < ?
        AND portfolio_id = ?${runSql}
    `).run(...expireArgs);
    return snap;
  })();
}

async function settleQuotes(db, args, quotes) {
  const book = args.book || bookFor('live');
  const bySymbol = {};
  for (const quote of quotes) {
    if (!priceFresh(quote.ts, args.clock, args.maxPriceAgeMs)) continue;
    bySymbol[quote.symbol] = {
      openMicro: quote.priceMicro,
      highMicro: quote.priceMicro,
      lowMicro: quote.priceMicro,
      closeMicro: quote.priceMicro,
      ts: quote.ts,
      source: quote.source || 'feed',
    };
  }
  if (!Object.keys(bySymbol).length) return null;
  return onBars(db, {
    book,
    portfolioId: args.portfolioId,
    actor: args.actor,
    clock: args.clock,
    costs: args.costs,
    barsBySymbol: bySymbol,
    barTs: iso(args.clock),
    priceSource: quotes[0] && quotes[0].source,
  });
}

async function placeOrder(db, args) {
  const book = args.book || bookFor('live');
  const symbol = String((args.order && args.order.symbol) || '').toUpperCase();
  let quote = args.quote || null;
  if (!quote && args.feed && symbol) {
    const quotes = await args.feed.getLatest([symbol]);
    quote = quotes.find((row) => row.symbol === symbol) || quotes[0] || null;
  }
  const accepted = acceptIntent(db, {
    ...args,
    book,
    quote,
    throwOnReject: args.throwOnReject !== false,
  });
  if (accepted.replayed || !accepted.ok || args.resting) {
    return { ...accepted, state: book.kind === 'live' ? readState(db, args.portfolioId) : null };
  }
  if (args.feed) {
    const symbols = new Set([symbol]);
    for (const pos of positionMap(db, book, args.portfolioId).values()) {
      if (pos.qtyMicro > 0n) symbols.add(pos.symbol);
    }
    const quotes = await args.feed.getLatest([...symbols]);
    await settleQuotes(db, { ...args, book }, quotes);
  }
  const saved = db.prepare('SELECT * FROM ' + book.order + ' WHERE id = ?').get(accepted.order.id);
  return { ...accepted, order: saved || accepted.order, state: book.kind === 'live' ? readState(db, args.portfolioId) : null };
}

function cancelOrder(db, args) {
  const book = bookFor('live');
  const ts = iso(args.clock);
  return db.transaction(() => {
    const portfolio = requirePortfolio(db, book, args.portfolioId, args.actor);
    const order = db.prepare('SELECT * FROM paper_orders WHERE id = ? AND portfolio_id = ?').get(args.orderId, portfolio.id);
    if (!order) throw new PaperError('NOT_FOUND', 'Ordern finns inte.', 404);
    if (order.protective || (order.type === 'stop' && order.parent_order_id)) {
      throw new PaperError('STOP_REQUIRED', message('STOP_REQUIRED'));
    }
    if (order.status !== 'open') throw new PaperError('INVALID_ORDER', 'Bara öppna order kan makuleras.');
    db.prepare(`UPDATE paper_orders SET status = 'cancelled' WHERE id = ?`).run(order.id);
    audit(db, book, args.actor, 'order_cancel', { portfolioId: portfolio.id, orderId: order.id }, ts);
    return readState(db, portfolio.id);
  })();
}

function pausePortfolio(db, args) {
  const book = bookFor('live');
  const ts = iso(args.clock);
  if (!args.actor || (args.actor.type !== 'user' && args.actor.type !== 'agent')) {
    throw new PaperError('OWNER_ONLY', message('OWNER_ONLY'), 403);
  }
  return db.transaction(() => {
    const portfolio = requirePortfolio(db, book, args.portfolioId, args.actor);
    db.prepare(`UPDATE paper_portfolios SET status = 'paused', pause_reason = 'owner' WHERE id = ?`).run(portfolio.id);
    db.prepare(`UPDATE paper_orders SET status = 'cancelled' WHERE portfolio_id = ? AND status = 'open' AND side = 'buy'`).run(portfolio.id);
    audit(db, book, args.actor, 'pause', { portfolioId: portfolio.id, reason: 'owner' }, ts);
    return readState(db, portfolio.id);
  })();
}

function resumePortfolio(db, args) {
  const book = bookFor('live');
  const ts = iso(args.clock);
  if (!args.actor || args.actor.type !== 'user') {
    throw new PaperError('OWNER_ONLY', message('OWNER_ONLY'), 403);
  }
  return db.transaction(() => {
    const portfolio = requirePortfolio(db, book, args.portfolioId, args.actor);
    const view = equityFrom(db, book, portfolio.id, null);
    let peak = asMicro(portfolio.peak_equity_micro);
    if (portfolio.pause_reason === 'drawdown') peak = view.equity;
    db.prepare(`
      UPDATE paper_portfolios
      SET status = 'active', pause_reason = NULL, peak_equity_micro = ?
      WHERE id = ?
    `).run(bindInt(peak), portfolio.id);
    audit(db, book, args.actor, 'resume', {
      portfolioId: portfolio.id,
      previousReason: portfolio.pause_reason,
      peak: formatMicro(peak),
    }, ts);
    return readState(db, portfolio.id);
  })();
}

async function markPortfolio(db, args) {
  const book = bookFor('live');
  requirePortfolio(db, book, args.portfolioId, args.actor);
  const symbols = new Set(DEFAULT_WHITELIST);
  const quotes = await args.feed.getLatest([...symbols]);
  await settleQuotes(db, args, quotes);
  return readState(db, args.portfolioId);
}

function seedSimulatedCash(db, book, portfolioId, amountMicro, ts) {
  postLedger(db, book, portfolioId, 'seed:' + portfolioId, [
    { account: 'wallet', amount: -asMicro(amountMicro) },
    { account: 'cash', amount: asMicro(amountMicro) },
  ], 'seed', String(portfolioId), ts);
  db.prepare('UPDATE ' + book.portfolio + ' SET peak_equity_micro = ? WHERE id = ?')
    .run(bindInt(amountMicro), portfolioId);
}

function readState(db, portfolioId) {
  const book = bookFor('live');
  const portfolio = db.prepare('SELECT * FROM paper_portfolios WHERE id = ?').get(portfolioId);
  if (!portfolio) return null;
  const profile = loadProfile(db, portfolio.risk_profile_id);
  const view = equityFrom(db, book, portfolioId, null);
  const last = db.prepare(`
    SELECT * FROM paper_equity_snapshots WHERE portfolio_id = ? ORDER BY id DESC LIMIT 1
  `).get(portfolioId);
  return {
    portfolio,
    profile,
    cashMicro: view.cash,
    positionsValueMicro: view.positionsValue,
    equityMicro: last ? asMicro(last.equity_micro) : view.equity,
    drawdownBps: last ? asMicro(last.drawdown_bps) : 0n,
    parkedMinor: portfolio.parked_minor,
    positions: [...view.positions.values()].filter((pos) => pos.qtyMicro > 0n),
  };
}

function listOrders(db, portfolioId) {
  return db.prepare(`
    SELECT o.*, COALESCE(i.symbol, o.symbol) AS symbol
    FROM paper_orders o
    LEFT JOIN paper_instruments i ON i.id = o.instrument_id
    WHERE o.portfolio_id = ?
    ORDER BY o.id DESC
  `).all(portfolioId);
}

function listFills(db, portfolioId) {
  return db.prepare(`
    SELECT f.*, o.side, o.type, o.client_order_id, i.symbol
    FROM paper_fills f
    JOIN paper_orders o ON o.id = f.order_id
    JOIN paper_instruments i ON i.id = o.instrument_id
    WHERE f.portfolio_id = ?
    ORDER BY f.id DESC
  `).all(portfolioId);
}

function listLedger(db, portfolioId) {
  return db.prepare(`
    SELECT id, tx_id, account, amount_micro, ref_type, ref_id, created_at
    FROM paper_ledger_entries
    WHERE portfolio_id = ?
    ORDER BY id ASC
  `).all(portfolioId);
}

function listEquity(db, portfolioId) {
  return db.prepare(`
    SELECT id, ts, cash_micro, positions_value_micro, equity_micro, drawdown_bps
    FROM paper_equity_snapshots
    WHERE portfolio_id = ?
    ORDER BY id ASC
  `).all(portfolioId);
}

function createApiKey(db, args) {
  const book = bookFor('live');
  const portfolio = requirePortfolio(db, book, args.portfolioId, args.actor);
  if (!args.actor || args.actor.type !== 'user') throw new PaperError('OWNER_ONLY', message('OWNER_ONLY'), 403);
  const raw = 'ggtdemo_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const ts = iso(args.clock);
  db.prepare(`
    INSERT INTO paper_api_keys (portfolio_id, key_prefix, key_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run(portfolio.id, raw.slice(0, 16), hash, ts);
  audit(db, book, args.actor, 'api_key_create', { portfolioId: portfolio.id, prefix: raw.slice(0, 16) }, ts);
  return { token: raw, prefix: raw.slice(0, 16) };
}

function authenticateApiKey(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 80 || !token.startsWith('ggtdemo_')) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`
    SELECT k.id, k.portfolio_id, p.owner_user_id
    FROM paper_api_keys k
    JOIN paper_portfolios p ON p.id = k.portfolio_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL
  `).get(hash);
  if (!row) return null;
  return {
    type: 'agent',
    id: 'key:' + row.id,
    userId: row.owner_user_id,
    portfolioId: row.portfolio_id,
    keyId: row.id,
  };
}

module.exports = {
  PaperError,
  MAX_PRICE_AGE_MS,
  bookFor,
  createPortfolio,
  allocate,
  withdraw,
  acceptIntent,
  placeOrder,
  onBars,
  cancelOrder,
  pausePortfolio,
  resumePortfolio,
  markPortfolio,
  seedSimulatedCash,
  readState,
  listOrders,
  listFills,
  listLedger,
  listEquity,
  listInstruments,
  createApiKey,
  authenticateApiKey,
  ledgerReport,
  equityFrom,
  LedgerError,
};

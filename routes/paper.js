const crypto = require('crypto');
const path = require('path');
const { DEMO_NOTICE, SIMULATED_RESULT, SIMULATED_RESULT_LONG } = require('../lib/demo-notice');
const { parseAmountToMinor, formatMinor, issueWelcomeGrant, getAccountByUserId, LedgerError } = require('../lib/ledger');
const { resolveGeo, checkGeo } = require('../lib/paper/geo');
const { createPriceCache } = require('../lib/paper/cache');
const { createDefaultFeed } = require('../lib/paper/feeds');
const { message } = require('../lib/paper/risk');
const { formatMicro, formatQty, asMicro, notionalMicro, minorToMicro, MICRO_PER_DEMO } = require('../lib/paper/money');
const { getStrategy } = require('../lib/paper/strategies');
const { runEngineSession } = require('../lib/paper/backtest');
const engine = require('../lib/paper/engine');

const ALLOCATE_MAX_MINOR = 100000;

function send(res, status, body) {
  res.status(status).json({
    ...body,
    demo: true,
    notice: DEMO_NOTICE,
    simulated: true,
  });
}

function bearer(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)/);
  return match ? match[1] : '';
}

function attribution(feed) {
  return {
    id: feed.id,
    powered: feed.attribution,
    provided: feed.attributionSecondary || '',
    url: feed.attributionUrl || null,
    fictional: !!feed.fictional,
  };
}

function money(micro, digits) {
  return formatMicro(asMicro(micro || 0), digits == null ? 2 : digits);
}

function presentPosition(pos) {
  const mark = asMicro(pos.last_mark_micro || pos.avg_cost_micro || 0);
  return {
    symbol: pos.symbol,
    qty: formatQty(pos.qtyMicro),
    avgCost: money(pos.avg_cost_micro, 2),
    marketValue: money(notionalMicro(mark, pos.qtyMicro)),
  };
}

function presentState(state, feed) {
  return {
    id: state.portfolio.id,
    status: state.portfolio.status,
    pauseReason: state.portfolio.pause_reason,
    unit: 'GGT (demo)',
    cash: money(state.cashMicro),
    equity: money(state.equityMicro),
    drawdownPct: (Number(state.drawdownBps) / 100).toFixed(2),
    parked: formatMinor(state.parkedMinor),
    risk: {
      maxPositionPct: state.profile.max_position_pct,
      maxOpenPositions: state.profile.max_open_positions,
      maxOrderValuePct: state.profile.max_order_value_pct,
      maxTradesPerDay: state.profile.max_trades_per_day,
      defaultStopLossPct: state.profile.default_stop_loss_pct,
      maxDrawdownPct: state.profile.max_drawdown_pct,
      minCashPct: state.profile.min_cash_pct,
      whitelist: state.profile.whitelist,
    },
    positions: state.positions.map(presentPosition),
    attribution: attribution(feed),
    resultLabel: SIMULATED_RESULT,
  };
}

function presentOrder(order) {
  return {
    id: order.id,
    clientOrderId: order.client_order_id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    qty: formatQty(order.qty_base),
    status: order.status,
    rejectCode: order.reject_code,
    rejectMessage: order.reject_message,
    protective: !!order.protective,
    createdAt: order.created_at,
  };
}

function keyFor(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

module.exports = function paperRoutes(db, options = {}) {
  const express = require('express');
  const router = express.Router();
  const geo = resolveGeo(options.geo, process.env);
  const cache = createPriceCache({
    dir: path.join(options.dataDir || '.', 'price-cache'),
    key: options.priceCacheKey || process.env.GITGRAM_PRICE_CACHE_KEY,
  });
  const feed = options.priceFeed || createDefaultFeed(process.env, cache);
  const clock = options.clock || (() => new Date());

  function fail(res, err) {
    if (err instanceof engine.PaperError || err instanceof LedgerError) {
      return send(res, err.status || 400, { error: err.code, message: err.message });
    }
    throw err;
  }

  function sessionUser(req, res, next) {
    res.set('Cache-Control', 'no-store');
    res.locals.navTrade = true;
    if (!req.session.userId) return res.redirect('/login');
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.redirect('/login');
    req.paperUser = user;
    req.paperActor = { type: 'user', id: 'user:' + user.id, userId: user.id };
    next();
  }

  function apiActor(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const token = bearer(req);
    if (token) {
      const agent = engine.authenticateApiKey(db, token);
      if (!agent) return send(res, 401, { error: 'invalid_api_key', message: 'Ogiltig agentnyckel.' });
      req.paperActor = agent;
      return next();
    }
    if (!req.session.userId) return send(res, 401, { error: 'login_required', message: 'Login required.' });
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return send(res, 401, { error: 'login_required', message: 'Login required.' });
    req.paperUser = user;
    req.paperActor = { type: 'user', id: 'user:' + user.id, userId: user.id };
    next();
  }

  function ownerOnly(req, res, next) {
    if (!req.paperActor || req.paperActor.type !== 'user') {
      return send(res, 403, { error: 'OWNER_ONLY', message: message('OWNER_ONLY') });
    }
    next();
  }

  router.use((req, res, next) => {
    if (req.path !== '/trade' && !req.path.startsWith('/trade/') && !req.path.startsWith('/api/demo')) return next();
    const verdict = checkGeo(req, geo);
    if (verdict.ok) return next();
    if (req.path.startsWith('/api/demo')) {
      return send(res, 451, { error: 'GEO_BLOCKED', message: message('GEO_BLOCKED'), country: verdict.country || null });
    }
    if (!req.session.userId) return res.redirect('/login');
    return res.status(451).render('trade', blockedModel(req, verdict));
  });

  function blockedModel(req, verdict) {
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
    return baseModel(user, null, {
      blocked: true,
      formError: message('GEO_BLOCKED'),
      country: verdict.country,
    });
  }

  function baseModel(user, state, extra) {
    issueWelcomeGrant(db, user.id);
    const account = getAccountByUserId(db, user.id);
    return {
      title: 'Paper trading (demo) - GITGRAM',
      navTrade: true,
      notice: DEMO_NOTICE,
      simulatedLabel: SIMULATED_RESULT,
      simulatedLong: SIMULATED_RESULT_LONG,
      username: user.username,
      walletBalance: formatMinor(account ? account.balance_minor : 0),
      attribution: attribution(feed),
      instruments: engine.listInstruments(db).filter((row) => row.enabled),
      portfolio: state ? presentState(state, feed) : null,
      positions: state ? state.positions.map(presentPosition) : [],
      orders: state ? engine.listOrders(db, state.portfolio.id).slice(0, 12).map(presentOrder) : [],
      idempotencyKey: keyFor('alloc'),
      orderKey: keyFor('ord'),
      blocked: false,
      formError: null,
      formCode: null,
      formOk: null,
      geoNote: 'Region check uses the operator-supplied country header (' + geo.headerName + ') and GITGRAM_GEO_BLOCK_COUNTRIES. No geolocation vendor is bundled.',
      ...extra,
    };
  }

  function loadOwn(req) {
    return db.prepare('SELECT * FROM paper_portfolios WHERE owner_user_id = ? ORDER BY id DESC LIMIT 1').get(req.paperUser.id);
  }

  function takeFlash(req) {
    const flash = req.session.tradeFlash || null;
    if (flash) delete req.session.tradeFlash;
    return flash;
  }

  router.get('/trade', sessionUser, (req, res) => {
    const row = loadOwn(req);
    const state = row ? engine.readState(db, row.id) : null;
    const flash = takeFlash(req);
    res.render('trade', baseModel(req.paperUser, state, {
      formError: flash && flash.error,
      formCode: flash && flash.code,
      formOk: flash && flash.ok,
    }));
  });

  router.post('/trade/open', sessionUser, (req, res, next) => {
    const parsed = parseAmountToMinor(String(req.body.amount || ''), { maxMinor: ALLOCATE_MAX_MINOR });
    const key = String(req.body.idempotency_key || '');
    if (!parsed.ok) {
      req.session.tradeFlash = { error: parsed.message, code: parsed.code };
      return req.session.save(() => res.redirect('/trade'));
    }
    try {
      const id = engine.createPortfolio(db, {
        userId: req.paperUser.id,
        preset: 'hard-default',
        actor: req.paperActor,
        clock,
      });
      engine.allocate(db, {
        portfolioId: id,
        amountMinor: parsed.minor,
        idempotencyKey: key,
        actor: req.paperActor,
        clock,
      });
      req.session.tradeFlash = { ok: 'Simulerad portfölj öppnad. Inga riktiga pengar har flyttats.' };
      return req.session.save(() => res.redirect('/trade'));
    } catch (err) {
      if (err instanceof engine.PaperError || err instanceof LedgerError) {
        req.session.tradeFlash = { error: err.message, code: err.code };
        return req.session.save(() => res.redirect('/trade'));
      }
      return next(err);
    }
  });

  router.post('/trade/orders', sessionUser, async (req, res, next) => {
    const row = loadOwn(req);
    if (!row) {
      req.session.tradeFlash = { error: 'Öppna en simulerad portfölj först.', code: 'NOT_FOUND' };
      return req.session.save(() => res.redirect('/trade'));
    }
    try {
      await engine.placeOrder(db, {
        portfolioId: row.id,
        actor: req.paperActor,
        feed,
        clock,
        order: {
          clientOrderId: req.body.client_order_id,
          symbol: req.body.symbol,
          side: req.body.side,
          type: req.body.type,
          notionalPct: req.body.notional_pct,
          qty: req.body.qty,
          limitPrice: req.body.type === 'limit' ? req.body.limit_price : '',
          stopPrice: req.body.type === 'stop' ? (req.body.stop_price || req.body.limit_price) : '',
          stopLossPct: req.body.stop_loss_pct,
          timeInForce: req.body.time_in_force,
        },
      });
      req.session.tradeFlash = { ok: 'Simulerad order registrerad. Fyllnaden är inte en riktig affär.' };
      return req.session.save(() => res.redirect('/trade#positions'));
    } catch (err) {
      if (err instanceof engine.PaperError || err instanceof LedgerError) {
        req.session.tradeFlash = { error: err.message, code: err.code };
        return req.session.save(() => res.redirect('/trade#order'));
      }
      return next(err);
    }
  });

  router.post('/trade/pause', sessionUser, (req, res, next) => {
    const row = loadOwn(req);
    if (!row) return res.redirect('/trade');
    try {
      engine.pausePortfolio(db, { portfolioId: row.id, actor: req.paperActor, clock });
      req.session.tradeFlash = { ok: 'Portföljen är pausad. Stop-order ligger kvar.' };
      return req.session.save(() => res.redirect('/trade'));
    } catch (err) {
      if (err instanceof engine.PaperError) {
        req.session.tradeFlash = { error: err.message, code: err.code };
        return req.session.save(() => res.redirect('/trade'));
      }
      return next(err);
    }
  });

  router.post('/trade/resume', sessionUser, (req, res, next) => {
    const row = loadOwn(req);
    if (!row) return res.redirect('/trade');
    try {
      engine.resumePortfolio(db, { portfolioId: row.id, actor: req.paperActor, clock });
      req.session.tradeFlash = { ok: 'Handeln är återaktiverad av ägaren. Resultatet är fortfarande simulerat.' };
      return req.session.save(() => res.redirect('/trade'));
    } catch (err) {
      if (err instanceof engine.PaperError) {
        req.session.tradeFlash = { error: err.message, code: err.code };
        return req.session.save(() => res.redirect('/trade'));
      }
      return next(err);
    }
  });

  router.post('/trade/withdraw', sessionUser, (req, res, next) => {
    const row = loadOwn(req);
    const parsed = parseAmountToMinor(String(req.body.amount || ''), { maxMinor: ALLOCATE_MAX_MINOR });
    if (!row || !parsed.ok) {
      req.session.tradeFlash = { error: parsed.ok ? 'Öppna en simulerad portfölj först.' : parsed.message, code: parsed.code || 'NOT_FOUND' };
      return req.session.save(() => res.redirect('/trade'));
    }
    try {
      engine.withdraw(db, {
        portfolioId: row.id,
        amountMinor: parsed.minor,
        idempotencyKey: String(req.body.idempotency_key || ''),
        actor: req.paperActor,
        clock,
      });
      req.session.tradeFlash = { ok: 'Simulerad kassa flyttad tillbaka till plånboken.' };
      return req.session.save(() => res.redirect('/trade'));
    } catch (err) {
      if (err instanceof engine.PaperError || err instanceof LedgerError) {
        req.session.tradeFlash = { error: err.message, code: err.code };
        return req.session.save(() => res.redirect('/trade'));
      }
      return next(err);
    }
  });

  router.get('/trade/backtest', sessionUser, (req, res) => {
    const flash = takeFlash(req);
    res.render('backtest', {
      ...baseModel(req.paperUser, null, {}),
      title: 'Backtest (demo) - GITGRAM',
      result: flash && flash.result,
      formError: flash && flash.error,
      strategies: [
        { id: 'sma-cross', label: 'A. SMA 50/200 trend' },
        { id: 'monthly-rebalance', label: 'B. Monthly rebalance' },
        { id: 'rsi-revert', label: 'C. RSI mean reversion' },
      ],
    });
  });

  router.post('/trade/backtest', sessionUser, async (req, res, next) => {
    try {
      const strategyId = String(req.body.strategy_id || 'sma-cross');
      const params = {};
      if (req.body.short) params.short = Number(req.body.short);
      if (req.body.long) params.long = Number(req.body.long);
      const result = await runEngineSession(db, {
        mode: 'backtest',
        userId: req.paperUser.id,
        actor: req.paperActor,
        strategy: strategyId,
        params,
        universe: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'],
        from: req.body.from || '2024-01-01',
        to: req.body.to || '2025-12-31',
        startingMicro: 1000n * MICRO_PER_DEMO,
        feed,
        costs: { doubleCosts: req.body.double_costs === '1' },
        clock,
      });
      req.session.tradeFlash = { result };
      return req.session.save(() => res.redirect('/trade/backtest#backtest-result'));
    } catch (err) {
      if (err.code === 'UNKNOWN_STRATEGY' || err instanceof engine.PaperError) {
        req.session.tradeFlash = { error: err.message };
        return req.session.save(() => res.redirect('/trade/backtest'));
      }
      return next(err);
    }
  });

  router.get('/api/demo/instruments', apiActor, (req, res) => {
    send(res, 200, {
      instruments: engine.listInstruments(db),
      attribution: attribution(feed),
    });
  });

  router.get('/api/demo/portfolios', apiActor, (req, res) => {
    const rows = db.prepare('SELECT id FROM paper_portfolios WHERE owner_user_id = ? ORDER BY id').all(req.paperActor.userId);
    send(res, 200, {
      portfolios: rows.map((row) => presentState(engine.readState(db, row.id), feed)),
    });
  });

  router.post('/api/demo/portfolios', apiActor, ownerOnly, (req, res) => {
    try {
      const id = engine.createPortfolio(db, {
        userId: req.paperActor.userId,
        preset: req.body.preset,
        risk: req.body.risk,
        actor: req.paperActor,
        clock,
      });
      let state = engine.readState(db, id);
      if (req.body.allocate) {
        const parsed = parseAmountToMinor(String(req.body.allocate), { maxMinor: ALLOCATE_MAX_MINOR });
        if (!parsed.ok) return send(res, 400, { error: parsed.code, message: parsed.message });
        state = engine.allocate(db, {
          portfolioId: id,
          amountMinor: parsed.minor,
          idempotencyKey: String(req.body.idempotencyKey || req.body.idempotency_key || ''),
          actor: req.paperActor,
          clock,
        });
      }
      send(res, 201, { portfolio: presentState(state, feed) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/api/demo/portfolios/:id', apiActor, (req, res) => {
    try {
      const state = engine.readState(db, Number(req.params.id));
      if (!state) return send(res, 404, { error: 'NOT_FOUND', message: 'Portföljen finns inte.' });
      const actor = req.paperActor;
      if (actor.type === 'agent' && actor.portfolioId !== state.portfolio.id) {
        return send(res, 403, { error: 'FORBIDDEN', message: 'Agentnyckeln gäller en annan portfölj.' });
      }
      if (actor.type === 'user' && state.portfolio.owner_user_id !== actor.userId) {
        return send(res, 403, { error: 'FORBIDDEN', message: 'Den portföljen tillhör en annan användare.' });
      }
      send(res, 200, { portfolio: presentState(state, feed) });
    } catch (err) {
      fail(res, err);
    }
  });

  function owned(req, res) {
    const state = engine.readState(db, Number(req.params.id));
    if (!state) {
      send(res, 404, { error: 'NOT_FOUND', message: 'Portföljen finns inte.' });
      return null;
    }
    const actor = req.paperActor;
    if (actor.type === 'agent' && actor.portfolioId !== state.portfolio.id) {
      send(res, 403, { error: 'FORBIDDEN', message: 'Agentnyckeln gäller en annan portfölj.' });
      return null;
    }
    if (actor.type === 'user' && state.portfolio.owner_user_id !== actor.userId) {
      send(res, 403, { error: 'FORBIDDEN', message: 'Den portföljen tillhör en annan användare.' });
      return null;
    }
    return state;
  }

  router.post('/api/demo/portfolios/:id/allocate', apiActor, ownerOnly, (req, res) => {
    if (!owned(req, res)) return;
    const parsed = parseAmountToMinor(String(req.body.amount || req.body.allocate || ''), { maxMinor: ALLOCATE_MAX_MINOR });
    if (!parsed.ok) return send(res, 400, { error: parsed.code, message: parsed.message });
    try {
      const state = engine.allocate(db, {
        portfolioId: Number(req.params.id),
        amountMinor: parsed.minor,
        idempotencyKey: String(req.body.idempotencyKey || req.body.idempotency_key || ''),
        actor: req.paperActor,
        clock,
      });
      send(res, 200, { portfolio: presentState(state, feed) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/demo/portfolios/:id/withdraw', apiActor, ownerOnly, (req, res) => {
    if (!owned(req, res)) return;
    const parsed = parseAmountToMinor(String(req.body.amount || ''), { maxMinor: ALLOCATE_MAX_MINOR });
    if (!parsed.ok) return send(res, 400, { error: parsed.code, message: parsed.message });
    try {
      const state = engine.withdraw(db, {
        portfolioId: Number(req.params.id),
        amountMinor: parsed.minor,
        idempotencyKey: String(req.body.idempotencyKey || req.body.idempotency_key || ''),
        actor: req.paperActor,
        clock,
      });
      send(res, 200, { portfolio: presentState(state, feed) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/demo/portfolios/:id/orders', apiActor, async (req, res) => {
    if (!owned(req, res)) return;
    try {
      const result = await engine.placeOrder(db, {
        portfolioId: Number(req.params.id),
        actor: req.paperActor,
        feed,
        clock,
        order: req.body || {},
      });
      const state = engine.readState(db, Number(req.params.id));
      send(res, result.replayed ? 200 : 201, {
        replayed: !!result.replayed,
        order: presentOrder(result.order),
        portfolio: presentState(state, feed),
        resultLabel: SIMULATED_RESULT,
      });
    } catch (err) {
      if (err instanceof engine.PaperError) {
        return send(res, err.status || 400, {
          error: err.code,
          message: err.message,
          order: err.order ? presentOrder(err.order) : null,
          resultLabel: SIMULATED_RESULT,
        });
      }
      fail(res, err);
    }
  });

  router.delete('/api/demo/portfolios/:id/orders/:orderId', apiActor, (req, res) => {
    if (!owned(req, res)) return;
    try {
      engine.cancelOrder(db, {
        portfolioId: Number(req.params.id),
        orderId: Number(req.params.orderId),
        actor: req.paperActor,
        clock,
      });
      send(res, 200, { status: 'cancelled', resultLabel: SIMULATED_RESULT });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/api/demo/portfolios/:id/orders', apiActor, (req, res) => {
    if (!owned(req, res)) return;
    send(res, 200, { orders: engine.listOrders(db, Number(req.params.id)).map(presentOrder), resultLabel: SIMULATED_RESULT });
  });

  router.get('/api/demo/portfolios/:id/fills', apiActor, (req, res) => {
    if (!owned(req, res)) return;
    const fills = engine.listFills(db, Number(req.params.id)).map((fill) => ({
      id: fill.id,
      symbol: fill.symbol,
      side: fill.side,
      qty: formatQty(fill.qty_base),
      price: money(fill.price_micro, 6),
      fee: money(fill.fee_micro, 6),
      source: fill.price_source,
      filledAt: fill.filled_at,
    }));
    send(res, 200, { fills, attribution: attribution(feed), resultLabel: SIMULATED_RESULT });
  });

  router.get('/api/demo/portfolios/:id/positions', apiActor, (req, res) => {
    const state = owned(req, res);
    if (!state) return;
    send(res, 200, { positions: state.positions.map(presentPosition), attribution: attribution(feed), resultLabel: SIMULATED_RESULT });
  });

  router.get('/api/demo/portfolios/:id/ledger', apiActor, (req, res) => {
    if (!owned(req, res)) return;
    const entries = engine.listLedger(db, Number(req.params.id)).map((row) => ({
      id: row.id,
      txId: row.tx_id,
      account: row.account,
      amount: money(row.amount_micro, 6),
      refType: row.ref_type,
      refId: row.ref_id,
      createdAt: row.created_at,
    }));
    send(res, 200, { entries, resultLabel: SIMULATED_RESULT });
  });

  router.get('/api/demo/portfolios/:id/equity', apiActor, (req, res) => {
    if (!owned(req, res)) return;
    const points = engine.listEquity(db, Number(req.params.id)).map((row) => ({
      ts: row.ts,
      cash: money(row.cash_micro),
      positionsValue: money(row.positions_value_micro),
      equity: money(row.equity_micro),
      drawdownPct: (Number(row.drawdown_bps) / 100).toFixed(2),
    }));
    send(res, 200, { equity: points, resultLabel: SIMULATED_RESULT });
  });

  router.post('/api/demo/portfolios/:id/pause', apiActor, (req, res) => {
    if (!owned(req, res)) return;
    try {
      const state = engine.pausePortfolio(db, { portfolioId: Number(req.params.id), actor: req.paperActor, clock });
      send(res, 200, { portfolio: presentState(state, feed) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/demo/portfolios/:id/resume', apiActor, ownerOnly, (req, res) => {
    if (!owned(req, res)) return;
    try {
      const state = engine.resumePortfolio(db, { portfolioId: Number(req.params.id), actor: req.paperActor, clock });
      send(res, 200, { portfolio: presentState(state, feed) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/demo/portfolios/:id/keys', apiActor, ownerOnly, (req, res) => {
    if (!owned(req, res)) return;
    try {
      const created = engine.createApiKey(db, { portfolioId: Number(req.params.id), actor: req.paperActor, clock });
      send(res, 201, { token: created.token, prefix: created.prefix, resultLabel: SIMULATED_RESULT });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/demo/backtests', apiActor, ownerOnly, async (req, res) => {
    const strategy = getStrategy(req.body.strategyId || req.body.strategy_id);
    if (!strategy) return send(res, 400, { error: 'UNKNOWN_STRATEGY', message: 'Okänd strategi.' });
    try {
      const starting = req.body.starting
        ? minorToMicro(parseAmountToMinor(String(req.body.starting), { maxMinor: ALLOCATE_MAX_MINOR }).minor || 0)
        : 1000n * MICRO_PER_DEMO;
      const result = await runEngineSession(db, {
        mode: 'backtest',
        userId: req.paperActor.userId,
        actor: req.paperActor,
        strategy,
        params: req.body.params || {},
        universe: req.body.universe,
        from: req.body.from,
        to: req.body.to,
        startingMicro: starting,
        feed,
        costs: req.body.costs || {},
        clock,
      });
      send(res, 201, {
        id: result.runId,
        status: 'completed',
        strategyId: result.strategyId,
        resultLabel: result.resultLabel,
        resultLabelLong: result.resultLabelLong,
        metrics: result.metrics,
        benchmarks: result.benchmarks,
        equity: result.equity,
        trades: result.trades,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/api/demo/backtests/:id', apiActor, (req, res) => {
    const run = db.prepare('SELECT * FROM bt_runs WHERE id = ?').get(Number(req.params.id));
    if (!run || run.owner_user_id !== req.paperActor.userId) {
      return send(res, 404, { error: 'NOT_FOUND', message: 'Backtesten finns inte.' });
    }
    send(res, 200, {
      id: run.id,
      status: run.status,
      strategyId: run.strategy_id,
      resultLabel: run.result_label,
      resultLabelLong: SIMULATED_RESULT_LONG,
      metrics: run.metrics_json ? JSON.parse(run.metrics_json) : null,
    });
  });

  router.use('/api/demo', apiActor, (req, res) => {
    send(res, 404, { error: 'not_found', message: 'Den vägen finns inte. Prisserier publiceras inte.' });
  });

  return router;
};

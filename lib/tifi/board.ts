const engine = require('../paper/engine');
const { formatMicro, asMicro, notionalMicro } = require('../paper/money') as {
  formatMicro: (value: any, digits?: number) => string;
  asMicro: (value: any) => bigint;
  notionalMicro: (price: any, qty: any) => bigint;
};
const { formatMinor } = require('../ledger') as { formatMinor: (minor: number) => string };
const { DEMO_NOTICE, SIMULATED_RESULT } = require('../demo-notice') as {
  DEMO_NOTICE: string;
  SIMULATED_RESULT: string;
};
const { getTreasury, listTigers, freeMinor } = require('./treasury.ts') as {
  getTreasury: (db: any, userId: number) => any;
  listTigers: (db: any, userId: number) => any[];
  freeMinor: (state: any) => number;
};
const { ensureRunner } = require('./runner.ts') as { ensureRunner: (db: any, userId: number) => any };
const { portraitThumb } = require('./portraits.ts') as {
  portraitThumb: (slot: number, ready?: boolean) => string;
};

const MICRO_PER_MINOR = 10000n;
const ACCENT = ['#FF7A1A', '#FFB547', '#EDE6DA'];

function labelRef(ref: string, tigers: any[]): string {
  if (ref === 'treasury') return 'Kassa';
  if (ref === 'wallet') return 'Plånbok';
  const tiger = tigers.find((row) => String(row.id) === String(ref));
  return tiger ? tiger.name : ref;
}

function money(micro: any): string {
  return formatMicro(asMicro(micro || 0), 2);
}

function sv(raw: string): string {
  return String(raw).replace(/,/g, '\u00a0').replace(/\./g, ',');
}

function svMoney(micro: any, digits?: number): string {
  const places = digits == null ? 2 : digits;
  let raw = formatMicro(asMicro(micro || 0), places);
  if (places <= 0) raw = raw.replace(/\.$/, '');
  return sv(raw);
}

function svSigned(micro: bigint, digits?: number): string {
  const abs = micro < 0n ? -micro : micro;
  const body = sv(formatMicro(abs, digits == null ? 2 : digits));
  if (micro > 0n) return '+' + body;
  if (micro < 0n) return '\u2212' + body;
  return body;
}

function svPct(value: number, digits?: number): string {
  const d = digits == null ? 2 : digits;
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return sign + Math.abs(value).toFixed(d).replace('.', ',') + ' %';
}

function percentFrom(equityMicro: bigint, allocatedMinor: number): number {
  const base = BigInt(allocatedMinor) * MICRO_PER_MINOR;
  if (base <= 0n) return 0;
  return Number((equityMicro - base) * 10000n / base) / 100;
}

function clockLabel(ts: string): string {
  if (!ts) return '';
  const time = ts.length >= 16 ? ts.slice(11, 16) : '';
  if (time && time !== '00:00') return time;
  return ts.slice(0, 10);
}

function chartOf(values: number[], color: string): any {
  const series = values.length >= 2 ? values : [values[0] || 0, values[0] || 0];
  const base = series[0] || 0;
  const pcts = series.map((value) => (base ? ((value - base) / base) * 100 : 0));
  let min = Math.min(...pcts, 0);
  let max = Math.max(...pcts, 0);
  if (max - min < 0.02) {
    min = -0.7;
    max = 0.7;
  }
  const pad = (max - min) * 0.08 || 0.05;
  min -= pad;
  max += pad;
  const span = max - min || 1;
  const pts = pcts.map((pct, index) => {
    const x = (index / (pcts.length - 1)) * 300;
    const y = 20 + ((max - pct) / span) * 110;
    return [x, y];
  });
  const line = pts.map((pt, index) => (index ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return {
    line,
    area: line + ' L300 150 L0 150 Z',
    color,
    x: last[0].toFixed(1),
    y: last[1].toFixed(1),
    top: svPct(max, 1),
    bottom: svPct(min, 1),
  };
}

function actionBars(probs: any, hasPosition: boolean): any[] {
  const buy = Math.round(Number(probs.buy || 0) * 100);
  const sell = Math.round(Number(probs.sell || 0) * 100);
  const hold = Math.max(0, 100 - buy - sell);
  if (buy >= sell && buy >= hold && buy > 0) {
    return [{ label: 'RID', pct: buy, on: true }];
  }
  if (sell > buy && sell >= hold) {
    return [
      { label: 'STÄNG', pct: sell, on: true },
      { label: 'BEHÅLL', pct: hold, on: false },
      { label: 'BLANKA', pct: 0, on: false },
    ];
  }
  if (!hasPosition) return [{ label: 'AVVAKTA', pct: hold, on: true }];
  return [
    { label: 'BEHÅLL', pct: hold, on: true },
    { label: 'STÄNG', pct: sell, on: false },
    { label: 'BLANKA', pct: 0, on: false },
  ];
}

function primaryAction(bars: any[]): string {
  const on = bars.find((bar) => bar.on);
  return on ? on.label : 'AVVAKTA';
}

function presentTiger(db: any, row: any, rank: number, leaderPct: number): any {
  const state = engine.readState(db, row.portfolio_id);
  const equity = state ? asMicro(state.equityMicro) : 0n;
  const cash = state ? asMicro(state.cashMicro) : 0n;
  const pct = percentFrom(equity, row.allocated_minor);
  const pnl = equity - BigInt(row.allocated_minor) * MICRO_PER_MINOR;
  const positions = state ? state.positions : [];
  const pos = positions[0] || null;
  const stop = db.prepare(`
    SELECT stop_price_micro FROM paper_orders
    WHERE portfolio_id = ? AND status = 'open' AND protective = 1
    ORDER BY id DESC LIMIT 1
  `).get(row.portfolio_id);
  const snaps = engine.listEquity(db, row.portfolio_id).slice(-48);
  const values = snaps.map((snap: any) => Number(asMicro(snap.equity_micro)) / 1e6);
  const decision = db.prepare(`
    SELECT * FROM tifi_decisions WHERE tiger_id = ? ORDER BY id DESC LIMIT 1
  `).get(row.id);
  const day = row.day_utc || '';
  const trades = db.prepare(`
    SELECT COUNT(*) AS n
    FROM paper_fills f
    JOIN paper_orders o ON o.id = f.order_id
    WHERE f.portfolio_id = ? AND o.protective = 0 AND substr(f.filled_at, 1, 10) = ?
  `).get(row.portfolio_id, day);
  const feesToday = db.prepare(`
    SELECT COALESCE(SUM(fee_micro), 0) AS n FROM paper_fills
    WHERE portfolio_id = ? AND substr(filled_at, 1, 10) = ?
  `).get(row.portfolio_id, day);
  const feesAll = db.prepare(`
    SELECT COALESCE(SUM(fee_micro), 0) AS n FROM paper_fills WHERE portfolio_id = ?
  `).get(row.portfolio_id);
  const calls = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(model_cost_micro), 0) AS cost FROM tifi_decisions WHERE tiger_id = ?').get(row.id);
  const probs = decision ? JSON.parse(decision.probabilities_json) : { buy: 0, sell: 0, hold: 1 };
  const feeCap = equity * BigInt(row.fee_budget_pct) / 100n;
  let unreal = 0n;
  let notional = 0n;
  for (const item of positions) {
    const mark = asMicro(item.last_mark_micro || item.avg_cost_micro);
    const value = notionalMicro(mark, item.qtyMicro);
    notional += value;
    unreal += value - asMicro(item.costMicro);
  }
  const slot = row.slot || 1;
  const color = ACCENT[slot - 1] || ACCENT[0];
  const symbols = JSON.parse(row.symbols_json || '[]');
  const bars = actionBars(probs, !!pos);
  const tradesN = trades ? trades.n : 0;
  const feesTodayMicro = asMicro(feesToday ? feesToday.n : 0);
  const feeWidth = feeCap > 0n ? Number(feesTodayMicro * 100n / feeCap) : 0;
  const tradeWidth = row.max_trades_per_day > 0 ? Math.round((tradesN / row.max_trades_per_day) * 100) : 0;
  const gap = rank === 1 ? 'leder' : svPct(leaderPct - pct, 2).replace(' %', '').replace(/^\+/, '') + ' efter';
  return {
    id: row.id,
    slot,
    name: row.name,
    tagline: row.tagline,
    personality: /^den /.test(String(row.tagline || '')),
    strategy: row.strategy,
    strategyLabel: row.strategy === 'breakout' ? 'Utbrott' : row.strategy === 'trend' ? 'Trend' : 'Momentum',
    coin: pos ? pos.symbol : (symbols[0] || ''),
    accent: 'var(--tifi-t' + slot + ')',
    color,
    status: row.status,
    pauseReason: row.pause_reason,
    rank,
    gap,
    equity: svMoney(equity),
    equityMicro: equity.toString(),
    pnl: svSigned(pnl),
    pnlUp: pnl > 0n,
    pnlDown: pnl < 0n,
    percent: pct,
    percentLabel: svPct(pct),
    allocated: sv(formatMinor(row.allocated_minor)),
    allocatedMinor: row.allocated_minor,
    portrait: portraitThumb(slot, true),
    variant: slot,
    flat: !pos,
    positionNotional: svMoney(notional, 0),
    cash: svMoney(cash),
    position: pos ? {
      symbol: pos.symbol,
      entry: svMoney(pos.avg_cost_micro, 1),
      mark: svMoney(pos.last_mark_micro || pos.avg_cost_micro, 1),
      stop: stop ? svMoney(stop.stop_price_micro, 1) : '\u2013',
      unreal: svSigned(unreal),
      unrealUp: unreal > 0n,
    } : null,
    chart: chartOf(values.length ? values : [0, 0], color),
    chartStart: snaps.length ? clockLabel(snaps[0].ts) : '',
    chartEnd: snaps.length ? clockLabel(snaps[snaps.length - 1].ts) : '',
    decision: decision ? {
      verdict: decision.guard_verdict,
      action: primaryAction(bars),
      rationale: decision.rationale,
      reasons: JSON.parse(decision.guard_reasons_json),
      probabilities: probs,
      bars,
      ts: decision.ts,
      modelId: decision.model_id,
    } : {
      verdict: null,
      action: 'AVVAKTA',
      rationale: 'Inget beslut ännu.',
      reasons: [],
      probabilities: probs,
      bars: [{ label: 'AVVAKTA', pct: 100, on: true }],
      ts: null,
      modelId: null,
    },
    tradesToday: tradesN,
    tradeCap: row.max_trades_per_day,
    tradeWidth: Math.max(0, Math.min(100, tradeWidth)),
    feesToday: svMoney(feesTodayMicro),
    feeBudget: svMoney(feeCap),
    feeWidth: Math.max(0, Math.min(100, feeWidth)),
    fees: svMoney(feesAll ? feesAll.n : 0),
    funding: '+0,00',
    modelCost: (Number(calls ? calls.cost : 0) / 1e6).toFixed(4).replace('.', ','),
    calls: calls ? calls.n : 0,
    aiLabel: 'AI-tiger',
  };
}

function loadBoard(db: any, userId: number): any {
  const tigers = listTigers(db, userId);
  const cards = tigers.map((row) => {
    const state = engine.readState(db, row.portfolio_id);
    const equity = state ? asMicro(state.equityMicro) : 0n;
    return { row, percent: percentFrom(equity, row.allocated_minor), equity };
  });
  const ranked = cards.slice().sort((a, b) => b.percent - a.percent || a.row.id - b.row.id);
  const leaderPct = ranked.length ? ranked[0].percent : 0;
  const minPct = cards.reduce((min, item) => Math.min(min, item.percent), 0);
  const maxPct = cards.reduce((max, item) => Math.max(max, item.percent), 0);
  const span = maxPct - minPct;
  const rankOf = new Map<number, number>();
  ranked.forEach((item, index) => rankOf.set(item.row.id, index + 1));
  const presented = cards.map((item) => presentTiger(db, item.row, rankOf.get(item.row.id) || 0, leaderPct));
  const treasury = getTreasury(db, userId);
  const treasuryState = treasury ? engine.readState(db, treasury.portfolio_id) : null;
  const transfers = db.prepare(`
    SELECT * FROM tifi_transfers WHERE user_id = ? ORDER BY id DESC LIMIT 12
  `).all(userId);
  const decisions = db.prepare(`
    SELECT d.*, t.name AS tiger_name, t.slot AS tiger_slot
    FROM tifi_decisions d
    JOIN tifi_tigers t ON t.id = d.tiger_id
    WHERE d.user_id = ?
    ORDER BY d.id DESC
    LIMIT 18
  `).all(userId);
  const runner = ensureRunner(db, userId);
  let pnl = 0n;
  let calls = 0;
  let pool = 0n;
  for (const card of presented) {
    const row = tigers.find((tiger) => tiger.id === card.id);
    const state = row ? engine.readState(db, row.portfolio_id) : null;
    const equity = state ? asMicro(state.equityMicro) : 0n;
    pnl += equity - BigInt(row.allocated_minor) * MICRO_PER_MINOR;
    pool += equity;
    calls += card.calls;
  }
  const allocatedSum = presented.reduce((sum, card) => sum + card.allocatedMinor, 0) || 1;
  const feeRow = db.prepare(`
    SELECT COALESCE(SUM(f.fee_micro), 0) AS n
    FROM paper_fills f
    JOIN tifi_tigers t ON t.portfolio_id = f.portfolio_id
    WHERE t.user_id = ?
  `).get(userId);
  const costRow = db.prepare('SELECT COALESCE(SUM(model_cost_micro), 0) AS n FROM tifi_decisions WHERE user_id = ?').get(userId);
  const fees = asMicro(feeRow ? feeRow.n : 0);
  const model = asMicro(costRow ? costRow.n : 0);
  const orderCount = db.prepare(`
    SELECT COUNT(*) AS n FROM paper_fills f
    JOIN tifi_tigers t ON t.portfolio_id = f.portfolio_id
    WHERE t.user_id = ?
  `).get(userId);
  const now = new Date();
  const created = tigers[0] && tigers[0].created_at ? Date.parse(tigers[0].created_at) : now.getTime();
  const day = Math.max(1, Math.floor((now.getTime() - created) / 86400000) + 1);
  return {
    notice: DEMO_NOTICE,
    simulated: SIMULATED_RESULT,
    paperBadge: 'PAPER TRADING',
    day,
    clock: now.toISOString().slice(11, 19),
    tigerCount: presented.length,
    totals: {
      pnl: svSigned(pnl),
      pnlUp: pnl > 0n,
      pnlDown: pnl < 0n,
      fees: svMoney(fees),
      funding: '+0,00',
      modelCost: (Number(model) / 1e6).toFixed(4).replace('.', ','),
      decisions: calls,
      orders: orderCount ? orderCount.n : 0,
    },
    pool: svMoney(pool),
    tigers: presented,
    leaderboard: presented
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((card) => ({
        rank: card.rank,
        name: card.name,
        percentLabel: card.percentLabel,
        variant: card.variant,
        portrait: card.portrait,
        accent: card.accent,
        bar: span === 0 ? 100 : Math.round(70 + ((card.percent - minPct) / span) * 30),
      })),
    feed: decisions.map((row: any) => {
      const probs = JSON.parse(row.probabilities_json);
      const proposal = JSON.parse(row.proposal_json);
      const slot = row.tiger_slot || 1;
      const action = proposal.action === 'buy' ? 'RID' : proposal.action === 'sell' ? 'STÄNG' : 'AVVAKTA';
      const raw = proposal.action === 'buy' ? probs.buy : proposal.action === 'sell' ? probs.sell : probs.hold;
      const pct = Math.round(Number(raw || 0) * 100);
      return {
        id: row.id,
        tiger: row.tiger_name,
        slot,
        accent: 'var(--tifi-t' + slot + ')',
        verdict: row.guard_verdict,
        action,
        rationale: row.rationale,
        reasons: JSON.parse(row.guard_reasons_json),
        probabilities: probs,
        bars: [{ label: action, pct, on: true }],
        pct: pct + ' %',
        up: proposal.action === 'buy',
        down: proposal.action === 'sell',
        ts: row.ts,
      };
    }),
    treasury: {
      cash: treasuryState ? svMoney(treasuryState.cashMicro) : '0,00',
      freeMinor: treasuryState ? freeMinor(treasuryState) : 0,
      free: treasuryState ? sv(formatMinor(freeMinor(treasuryState))) : '0,00',
      weights: treasury ? JSON.parse(treasury.weights_json) : [34, 33, 33],
    },
    allocation: presented.map((card) => ({
      name: card.name,
      accent: card.accent,
      share: (Math.round((card.allocatedMinor / allocatedSum) * 1000) / 10).toFixed(1).replace('.', ','),
      allocated: card.allocated,
      inPosition: card.positionNotional,
      free: card.cash,
      weight: card.allocatedMinor,
    })),
    transfers: transfers.map((row: any) => ({
      id: row.id,
      from: labelRef(row.from_ref, tigers),
      to: labelRef(row.to_ref, tigers),
      amount: sv(formatMinor(row.amount_minor)),
      at: row.created_at,
    })),
    runner: { running: !!(runner && runner.running), cursor: runner ? runner.cursor_index : -1 },
    demo: true,
    unit: 'DEMO',
  };
}

module.exports = { loadBoard, percentFrom, money, sv, svMoney };

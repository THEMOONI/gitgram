// Plain-code guard. Limits may only be stricter than the paper engine ceilings.
// Leverage above 1× is refused. The paper ledger has no margin, so execution stays at 1×.

const { HARD } = require('../paper/risk') as {
  HARD: {
    maxPositionPct: number;
    maxOpenPositions: number;
    maxOrderValuePct: number;
    maxTradesPerDay: number;
    widestStopLossPct: number;
    maxDrawdownPct: number;
    minCashPct: number;
  };
};

const HARD_MAX_LEVERAGE = 1;
const DEFAULT_LEVERAGE = 1;

interface Limits {
  maxLeverage: number;
  maxStopPct: number;
  dailyLossPct: number;
  maxTradesPerDay: number;
  cooldownSec: number;
  maxPositionPct: number;
  feeBudgetPct: number;
  symbols: string[];
}

interface Proposal {
  action: 'buy' | 'sell' | 'hold';
  symbol: string | null;
  notionalPct: number | null;
  stopLossPct: number | null;
  leverage: number;
  rationale: string;
  probabilities: { buy: number; sell: number; hold: number };
}

interface GuardContext {
  nowIso: string;
  proposal: Proposal;
  limits: Limits;
  engineMaxPositionPct: number;
  engineMaxTradesPerDay: number;
  engineMaxStopPct: number;
  engineMaxOrderPct: number;
  status: string;
  pauseReason: string | null;
  tradesToday: number;
  lastTradeAt: string | null;
  feesTodayMicro: bigint;
  equityMicro: bigint;
  hasPosition: boolean;
}

interface GuardResult {
  verdict: 'allow' | 'reject' | 'pause';
  reasons: string[];
  codes: string[];
  order: null | {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market';
    notionalPct?: number;
    stopLossPct?: number;
    sellAll?: boolean;
  };
  leverageApplied: number;
}

function marginMultiplier(): number {
  // Paper books do not borrow. This stays at 1, so effective leverage cannot rise above 1×.
  return 1;
}

function effectiveLeverage(): number {
  return DEFAULT_LEVERAGE * marginMultiplier();
}

function asInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function validateLimits(input: Limits): string[] {
  const errors: string[] = [];
  if (!(input.maxLeverage >= 1 && input.maxLeverage <= HARD_MAX_LEVERAGE)) errors.push('leverage');
  if (!(input.maxStopPct >= 1 && input.maxStopPct <= HARD.widestStopLossPct)) errors.push('stop');
  if (!(input.maxTradesPerDay >= 1 && input.maxTradesPerDay <= HARD.maxTradesPerDay)) errors.push('trades');
  if (!(input.maxPositionPct >= 1 && input.maxPositionPct <= HARD.maxPositionPct)) errors.push('position');
  if (!(input.dailyLossPct >= 1 && input.dailyLossPct <= HARD.maxDrawdownPct)) errors.push('daily');
  if (!(input.cooldownSec >= 0 && input.cooldownSec <= 7 * 86400)) errors.push('cooldown');
  if (!(input.feeBudgetPct >= 1 && input.feeBudgetPct <= 100)) errors.push('fees');
  if (!input.symbols.length) errors.push('symbols');
  return errors;
}

function clampLimits(input: Partial<Limits> & { symbols?: string[] }): { limits: Limits; notes: string[] } {
  const notes: string[] = [];
  let maxLeverage = input.maxLeverage == null ? DEFAULT_LEVERAGE : Number(input.maxLeverage);
  if (maxLeverage > HARD_MAX_LEVERAGE) {
    notes.push('Hävstång över 1× avvisas. Pappershandeln stannar på 1×.');
    maxLeverage = HARD_MAX_LEVERAGE;
  }
  if (!(maxLeverage >= 1)) maxLeverage = DEFAULT_LEVERAGE;
  let maxStopPct = asInt(input.maxStopPct) ?? 8;
  if (maxStopPct > HARD.widestStopLossPct) {
    notes.push('Stoppgränsen sänktes till motorns tak.');
    maxStopPct = HARD.widestStopLossPct;
  }
  if (maxStopPct < 1) maxStopPct = 1;
  let maxTradesPerDay = asInt(input.maxTradesPerDay) ?? 2;
  if (maxTradesPerDay > HARD.maxTradesPerDay) {
    notes.push('Antalet affärer per dygn sänktes till motorns tak.');
    maxTradesPerDay = HARD.maxTradesPerDay;
  }
  if (maxTradesPerDay < 1) maxTradesPerDay = 1;
  let maxPositionPct = asInt(input.maxPositionPct) ?? 10;
  if (maxPositionPct > HARD.maxPositionPct) {
    notes.push('Positionsandelen sänktes till motorns tak.');
    maxPositionPct = HARD.maxPositionPct;
  }
  if (maxPositionPct < 1) maxPositionPct = 1;
  let dailyLossPct = asInt(input.dailyLossPct) ?? 5;
  if (dailyLossPct > HARD.maxDrawdownPct) {
    notes.push('Dagsförlusttaket sänktes till motorns tak.');
    dailyLossPct = HARD.maxDrawdownPct;
  }
  if (dailyLossPct < 1) dailyLossPct = 1;
  let cooldownSec = asInt(input.cooldownSec) ?? 3600;
  if (cooldownSec < 0) cooldownSec = 0;
  let feeBudgetPct = asInt(input.feeBudgetPct) ?? 5;
  if (feeBudgetPct < 1) feeBudgetPct = 1;
  if (feeBudgetPct > 100) feeBudgetPct = 100;
  const symbols = (input.symbols || []).map((symbol) => String(symbol).toUpperCase());
  return {
    limits: {
      maxLeverage,
      maxStopPct,
      dailyLossPct,
      maxTradesPerDay,
      cooldownSec,
      maxPositionPct,
      feeBudgetPct,
      symbols,
    },
    notes,
  };
}

function lossPct(startMicro: bigint, equityMicro: bigint): number {
  if (startMicro <= 0n || equityMicro >= startMicro) return 0;
  return Number((startMicro - equityMicro) * 10000n / startMicro) / 100;
}

function secondsBetween(earlier: string, later: string): number {
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / 1000;
}

function evaluateGuard(ctx: GuardContext): GuardResult {
  const reasons: string[] = [];
  const codes: string[] = [];
  const proposal = ctx.proposal;
  const applied = effectiveLeverage();

  if (ctx.status === 'paused' && ctx.pauseReason === 'owner') {
    return {
      verdict: 'reject',
      reasons: ['Tigern är pausad av ägaren. Bara ägaren kan återuppta.'],
      codes: ['PAUSED_OWNER'],
      order: null,
      leverageApplied: applied,
    };
  }
  if (ctx.status === 'paused' && ctx.pauseReason === 'daily_loss') {
    return {
      verdict: 'reject',
      reasons: ['Dagsförlusttaket är nått. Tigern är pausad resten av UTC-dygnet.'],
      codes: ['PAUSED_DAILY'],
      order: null,
      leverageApplied: applied,
    };
  }
  if (ctx.status === 'paused' && ctx.pauseReason === 'drawdown' && proposal.action === 'buy') {
    return {
      verdict: 'reject',
      reasons: ['Värdeminskningen nådde 20 % från toppen. Nya öppningar är spärrade tills ägaren återställer.'],
      codes: ['DRAWDOWN'],
      order: null,
      leverageApplied: applied,
    };
  }

  const loose = validateLimits(ctx.limits);
  if (loose.length) {
    return {
      verdict: 'reject',
      reasons: ['Tigerns gränser är lösare än motorns tak och kan inte användas.'],
      codes: ['CONFIG'],
      order: null,
      leverageApplied: applied,
    };
  }
  if (ctx.limits.maxPositionPct > ctx.engineMaxPositionPct
    || ctx.limits.maxTradesPerDay > ctx.engineMaxTradesPerDay
    || ctx.limits.maxStopPct > ctx.engineMaxStopPct
    || ctx.limits.maxPositionPct > ctx.engineMaxOrderPct) {
    return {
      verdict: 'reject',
      reasons: ['Tigerns gränser får inte vara lösare än portföljens riskprofil.'],
      codes: ['LOOSER_THAN_PROFILE'],
      order: null,
      leverageApplied: applied,
    };
  }

  if (proposal.action === 'hold' || !proposal.symbol) {
    return {
      verdict: 'allow',
      reasons: ['Ingen pappersorder. Modellen avvaktar.'],
      codes: ['HOLD'],
      order: null,
      leverageApplied: applied,
    };
  }

  if (proposal.leverage > HARD_MAX_LEVERAGE || proposal.leverage > applied) {
    codes.push('LEVERAGE');
    reasons.push('Hävstång över 1× är inte tillåten. Effektiv hävstång på papper är 1×.');
    return { verdict: 'reject', reasons, codes, order: null, leverageApplied: applied };
  }

  if (!ctx.limits.symbols.includes(proposal.symbol)) {
    return {
      verdict: 'reject',
      reasons: ['Symbolen ingår inte i tigerns tillåtna lista.'],
      codes: ['SYMBOL'],
      order: null,
      leverageApplied: applied,
    };
  }

  if (ctx.lastTradeAt && secondsBetween(ctx.lastTradeAt, ctx.nowIso) < ctx.limits.cooldownSec) {
    return {
      verdict: 'reject',
      reasons: ['Väntetiden mellan affärer har inte gått ut.'],
      codes: ['COOLDOWN'],
      order: null,
      leverageApplied: applied,
    };
  }

  if (ctx.tradesToday >= ctx.limits.maxTradesPerDay || ctx.tradesToday >= ctx.engineMaxTradesPerDay) {
    return {
      verdict: 'reject',
      reasons: ['Dagens affärstak är nått (UTC-dygn).'],
      codes: ['TRADE_CAP'],
      order: null,
      leverageApplied: applied,
    };
  }

  if (proposal.action === 'sell') {
    if (!ctx.hasPosition) {
      return {
        verdict: 'reject',
        reasons: ['Ingen simulerad position att stänga.'],
        codes: ['NO_POSITION'],
        order: null,
        leverageApplied: applied,
      };
    }
    return {
      verdict: 'allow',
      reasons: reasons.concat(['Stänger simulerad position.']),
      codes,
      order: { symbol: proposal.symbol, side: 'sell', type: 'market', sellAll: true },
      leverageApplied: applied,
    };
  }

  const feeCap = ctx.equityMicro * BigInt(ctx.limits.feeBudgetPct) / 100n;
  if (ctx.feesTodayMicro >= feeCap && feeCap > 0n) {
    return {
      verdict: 'reject',
      reasons: ['Dagens simulerade avgiftsbudget är förbrukad.'],
      codes: ['FEE_BUDGET'],
      order: null,
      leverageApplied: applied,
    };
  }

  let notional = proposal.notionalPct == null ? ctx.limits.maxPositionPct : Math.round(proposal.notionalPct);
  const positionCap = Math.min(ctx.limits.maxPositionPct, ctx.engineMaxPositionPct, ctx.engineMaxOrderPct);
  if (notional > positionCap) {
    reasons.push('Positionsandelen sänktes till tigerns tak.');
    codes.push('POSITION_CLAMP');
    notional = positionCap;
  }
  if (notional < 1) {
    return {
      verdict: 'reject',
      reasons: ['Positionsandelen är för liten.'],
      codes: ['POSITION'],
      order: null,
      leverageApplied: applied,
    };
  }

  let stop = proposal.stopLossPct == null ? ctx.limits.maxStopPct : Math.round(proposal.stopLossPct);
  const stopCap = Math.min(ctx.limits.maxStopPct, ctx.engineMaxStopPct);
  if (stop > stopCap) {
    return {
      verdict: 'reject',
      reasons: ['Stoppet är vidare än tigerns tak.'],
      codes: ['STOP_TOO_WIDE'],
      order: null,
      leverageApplied: applied,
    };
  }
  if (stop < 1) {
    return {
      verdict: 'reject',
      reasons: ['Ett stopp krävs för en simulerad öppning.'],
      codes: ['STOP_REQUIRED'],
      order: null,
      leverageApplied: applied,
    };
  }

  return {
    verdict: 'allow',
    reasons: reasons.concat(['Gränserna släppte igenom en simulerad öppning på 1×.']),
    codes,
    order: {
      symbol: proposal.symbol,
      side: 'buy',
      type: 'market',
      notionalPct: notional,
      stopLossPct: stop,
    },
    leverageApplied: applied,
  };
}

function dailyLossTripped(startMicro: bigint | null, equityMicro: bigint, capPct: number): boolean {
  if (startMicro == null) return false;
  return lossPct(startMicro, equityMicro) >= capPct;
}

function rollUtcDay(state: { status: string; pauseReason: string | null; dayUtc: string | null }, today: string): {
  status: string;
  pauseReason: string | null;
  reset: boolean;
} {
  if (state.dayUtc === today) return { status: state.status, pauseReason: state.pauseReason, reset: false };
  if (state.pauseReason === 'daily_loss') {
    return { status: 'active', pauseReason: null, reset: true };
  }
  return { status: state.status, pauseReason: state.pauseReason, reset: true };
}

module.exports = {
  HARD,
  HARD_MAX_LEVERAGE,
  DEFAULT_LEVERAGE,
  marginMultiplier,
  effectiveLeverage,
  validateLimits,
  clampLimits,
  lossPct,
  evaluateGuard,
  dailyLossTripped,
  rollUtcDay,
};

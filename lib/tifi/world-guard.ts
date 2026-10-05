// Plain-code guard for paper prediction markets. No leverage, and no orders
// in the last seconds before a market closes.

interface WorldGuardOrder {
  marketId: string | null;
  outcome: string;
  side: 'buy' | 'sell';
  stakeMicro: bigint;
}

interface WorldGuardResult {
  verdict: 'allow' | 'reject' | 'pause';
  reasons: string[];
  codes: string[];
  order: WorldGuardOrder | null;
}

function secondsUntil(nowIso: string, closesAt: string | null): number | null {
  if (!closesAt) return null;
  const now = Date.parse(nowIso);
  const close = Date.parse(closesAt);
  if (Number.isNaN(now) || Number.isNaN(close)) return null;
  return (close - now) / 1000;
}

function secondsBetween(earlier: string, later: string): number {
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / 1000;
}

function evaluateWorldGuard(ctx: {
  nowIso: string;
  action: 'up' | 'down' | 'abstain';
  outcome: string | null;
  side: 'buy' | 'sell' | null;
  marketId: string | null;
  closesAt: string | null;
  leverage: number;
  stakePct: number;
  maxStakePct: number;
  closeBufferSec: number;
  cashMicro: bigint;
  openStakeMicro: bigint;
  feeBps: number;
  minOrderMicro: bigint;
  tradesToday: number;
  maxTradesPerDay: number;
  lastTradeAt: string | null;
  cooldownSec: number;
  status: string;
  pauseReason: string | null;
  sellingSharesMicro?: bigint;
  neutral?: boolean;
}): WorldGuardResult {
  if (ctx.status === 'paused' && ctx.pauseReason === 'owner') {
    return {
      verdict: 'reject',
      reasons: ['Tigern är pausad av ägaren. Bara ägaren kan återuppta.'],
      codes: ['PAUSED_OWNER'],
      order: null,
    };
  }
  if (ctx.status === 'paused' && ctx.pauseReason === 'daily_loss') {
    return {
      verdict: 'pause',
      reasons: ['Dagsförlusttaket är nått. Tigern är pausad resten av UTC-dygnet.'],
      codes: ['PAUSED_DAILY'],
      order: null,
    };
  }
  if (ctx.status === 'paused' && ctx.pauseReason === 'drawdown' && ctx.side === 'buy') {
    return {
      verdict: 'reject',
      reasons: ['Värdeminskningen nådde 20 % från toppen. Nya öppningar är spärrade tills ägaren återställer.'],
      codes: ['DRAWDOWN'],
      order: null,
    };
  }
  if (ctx.action === 'abstain' || !ctx.outcome || !ctx.side) {
    return {
      verdict: 'allow',
      reasons: [ctx.neutral ? 'Avstår. Ingen order i det här fönstret.' : 'Avstår. Ingen World-order i det här fönstret.'],
      codes: ['ABSTAIN'],
      order: null,
    };
  }
  if (!(ctx.leverage <= 1)) {
    return {
      verdict: 'reject',
      reasons: ['Hävstång är inte tillåten på prediktionsmarknader.'],
      codes: ['NO_LEVERAGE'],
      order: null,
    };
  }
  const left = secondsUntil(ctx.nowIso, ctx.closesAt);
  if (left == null) {
    return {
      verdict: 'reject',
      reasons: ['Marknadens stängningstid saknas, så ingen order läggs.'],
      codes: ['CLOSE_UNKNOWN'],
      order: null,
    };
  }
  if (left <= ctx.closeBufferSec) {
    return {
      verdict: 'reject',
      reasons: ['Ingen handel de sista ' + ctx.closeBufferSec + ' sekunderna före stängning.'],
      codes: ['CLOSE_BUFFER'],
      order: null,
    };
  }
  if (ctx.lastTradeAt && secondsBetween(ctx.lastTradeAt, ctx.nowIso) < ctx.cooldownSec) {
    return {
      verdict: 'reject',
      reasons: ['Väntetiden mellan affärer har inte gått ut.'],
      codes: ['COOLDOWN'],
      order: null,
    };
  }
  if (ctx.tradesToday >= ctx.maxTradesPerDay) {
    return {
      verdict: 'reject',
      reasons: ['Dagens affärstak är nått (UTC-dygn).'],
      codes: ['TRADE_CAP'],
      order: null,
    };
  }
  if (ctx.side === 'sell') {
    if (!ctx.sellingSharesMicro || ctx.sellingSharesMicro <= 0n) {
      return {
        verdict: 'reject',
        reasons: ['Ingen simulerad andel att sälja.'],
        codes: ['NO_POSITION'],
        order: null,
      };
    }
    return {
      verdict: 'allow',
      reasons: ['Gränserna släppte igenom en simulerad försäljning. Ingen hävstång.'],
      codes: [],
      order: {
        marketId: ctx.marketId,
        outcome: ctx.outcome,
        side: 'sell',
        stakeMicro: ctx.sellingSharesMicro,
      },
    };
  }
  const requested = Math.round(ctx.stakePct);
  if (!(requested >= 1)) {
    return {
      verdict: 'reject',
      reasons: ['Insatsen är för liten.'],
      codes: ['STAKE'],
      order: null,
    };
  }
  if (requested > ctx.maxStakePct) {
    return {
      verdict: 'reject',
      reasons: ['Insatsen överstiger taket för den här marknaden.'],
      codes: ['STAKE'],
      order: null,
    };
  }
  const pct = requested;
  const cap = ctx.cashMicro * BigInt(pct) / 100n;
  const room = cap - (ctx.openStakeMicro > 0n ? ctx.openStakeMicro : 0n);
  if (room <= 0n) {
    return {
      verdict: 'reject',
      reasons: ['Insatsen överstiger taket för den här marknaden.'],
      codes: ['STAKE'],
      order: null,
    };
  }
  return {
    verdict: 'allow',
    reasons: [ctx.neutral ? 'Gränserna släppte igenom en simulerad insats. Ingen hävstång.' : 'Gränserna släppte igenom en simulerad World-insats. Ingen hävstång.'],
    codes: [],
    order: {
      marketId: ctx.marketId,
      outcome: ctx.outcome,
      side: 'buy',
      stakeMicro: room,
    },
  };
}

module.exports = {
  evaluateWorldGuard,
  secondsUntil,
};

const { BPS, asMicro, notionalMicro } = require('./money');

function applyAdverse(priceMicro, slippageBps, side) {
  const price = asMicro(priceMicro);
  const bps = BigInt(slippageBps);
  if (bps < 0n || bps > 500n) {
    throw new Error('slippage is out of range');
  }
  if (price <= 0n) return 0n;
  if (side === 'buy') return (price * (BPS + bps) + BPS - 1n) / BPS;
  return (price * (BPS - bps)) / BPS;
}

function feeFor(notional, feeBps) {
  const n = asMicro(notional);
  const bps = BigInt(feeBps);
  if (n <= 0n || bps <= 0n) return 0n;
  return n * bps / BPS;
}

function marketFill(priceMicro, side, slippageBps) {
  return applyAdverse(priceMicro, slippageBps, side);
}

function limitFill(bar, side, limitMicro) {
  const limit = asMicro(limitMicro);
  if (limit <= 0n) return null;
  if (side === 'buy') {
    if (asMicro(bar.lowMicro) > limit) return null;
    const open = asMicro(bar.openMicro);
    return open < limit ? open : limit;
  }
  if (asMicro(bar.highMicro) < limit) return null;
  const open = asMicro(bar.openMicro);
  return open > limit ? open : limit;
}

function stopFill(bar, stopMicro, slippageBps) {
  const stop = asMicro(stopMicro);
  if (stop <= 0n) return null;
  if (asMicro(bar.lowMicro) > stop) return null;
  const open = asMicro(bar.openMicro);
  const raw = open < stop ? open : stop;
  return applyAdverse(raw, slippageBps, 'sell');
}

module.exports = {
  applyAdverse,
  feeFor,
  marketFill,
  limitFill,
  stopFill,
  notionalMicro,
};

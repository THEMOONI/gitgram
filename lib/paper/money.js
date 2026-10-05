const MICRO_PER_DEMO = 1000000n;
const MICRO_PER_MINOR = 10000n;
const QTY_SCALE = 1000000n;
const BPS = 10000n;
const SAFE = 9007199254740991n;

function asMicro(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('bad amount');
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error('bad amount');
}

function bindInt(value) {
  const n = asMicro(value);
  if (n > SAFE || n < -SAFE) {
    const err = new Error('Amount exceeds the demo ledger range.');
    err.code = 'overflow';
    err.status = 400;
    throw err;
  }
  return Number(n);
}

function minorToMicro(minor) {
  return BigInt(minor) * MICRO_PER_MINOR;
}

function microToMinorFloor(micro) {
  const n = asMicro(micro);
  if (n <= 0n) return 0n;
  return n / MICRO_PER_MINOR;
}

function formatMicro(micro, digits = 2) {
  const n = asMicro(micro);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / MICRO_PER_DEMO;
  const fracFull = (abs % MICRO_PER_DEMO).toString().padStart(6, '0');
  const frac = fracFull.slice(0, digits);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + '.' + frac;
}

function formatQty(qtyBase) {
  const n = asMicro(qtyBase);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / QTY_SCALE;
  const frac = (abs % QTY_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  const body = frac ? whole.toString() + '.' + frac : whole.toString();
  return (neg ? '-' : '') + body;
}

function parseDecimalToScaled(input, scaleDigits) {
  if (typeof input === 'number' && Number.isFinite(input)) input = String(input);
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const parts = raw.split('.');
  const whole = parts[0];
  const frac = parts[1] || '';
  if (frac.length > scaleDigits || whole.length > 12) return null;
  const padded = (frac + '0'.repeat(scaleDigits)).slice(0, scaleDigits);
  return BigInt(whole) * (10n ** BigInt(scaleDigits)) + BigInt(padded || '0');
}

function notionalMicro(priceMicro, qtyBase) {
  return asMicro(priceMicro) * asMicro(qtyBase) / QTY_SCALE;
}

function drawdownBps(peak, equity) {
  const p = asMicro(peak);
  const e = asMicro(equity);
  if (p <= 0n || e >= p) return 0n;
  return (p - e) * BPS / p;
}

module.exports = {
  MICRO_PER_DEMO,
  MICRO_PER_MINOR,
  QTY_SCALE,
  BPS,
  asMicro,
  bindInt,
  minorToMicro,
  microToMinorFloor,
  formatMicro,
  formatQty,
  parseDecimalToScaled,
  notionalMicro,
  drawdownBps,
};

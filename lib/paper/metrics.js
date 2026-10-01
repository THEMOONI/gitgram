const { asMicro, notionalMicro } = require('./money');

function round(value) {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

function computeMetrics(equityRows, fills) {
  const points = equityRows.map((row) => ({
    ts: row.ts,
    equity: Number(asMicro(row.equity_micro)) / 1e6,
    invested: Number(asMicro(row.positions_value_micro)) > 0,
  }));
  const sells = fills.filter((fill) => fill.side === 'sell');
  const wins = sells.filter((fill) => asMicro(fill.realized_micro) > 0n);
  const losses = sells.filter((fill) => asMicro(fill.realized_micro) < 0n);
  const avg = (rows, sign) => {
    if (!rows.length) return null;
    const total = rows.reduce((sum, row) => sum + Number(asMicro(row.realized_micro)) / 1e6, 0);
    return round(sign * total / rows.length);
  };
  let cagr = null;
  let sharpe = null;
  let sortino = null;
  let maxDrawdown = 0;
  let longestDrawdownBars = 0;
  if (points.length >= 2 && points[0].equity > 0) {
    const start = Date.parse(points[0].ts);
    const end = Date.parse(points[points.length - 1].ts);
    const days = (end - start) / 86400000;
    if (days >= 1) {
      cagr = (points[points.length - 1].equity / points[0].equity) ** (365.25 / days) - 1;
    }
    const returns = [];
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1].equity;
      returns.push(prev > 0 ? points[i].equity / prev - 1 : 0);
    }
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    const stdev = Math.sqrt(variance);
    if (stdev > 0) sharpe = (mean / stdev) * Math.sqrt(365);
    const downside = returns.filter((value) => value < 0);
    if (downside.length) {
      const downDev = Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length);
      if (downDev > 0) sortino = (mean / downDev) * Math.sqrt(365);
    }
    let peak = points[0].equity;
    let underwater = null;
    for (let i = 0; i < points.length; i += 1) {
      if (points[i].equity >= peak) {
        if (underwater != null) longestDrawdownBars = Math.max(longestDrawdownBars, i - underwater);
        underwater = null;
        peak = points[i].equity;
      } else {
        if (underwater == null) underwater = i;
        maxDrawdown = Math.max(maxDrawdown, (peak - points[i].equity) / peak);
      }
    }
    if (underwater != null) longestDrawdownBars = Math.max(longestDrawdownBars, points.length - 1 - underwater);
  }
  const years = points.length >= 2
    ? Math.max(1 / 365.25, (Date.parse(points[points.length - 1].ts) - Date.parse(points[0].ts)) / 86400000 / 365.25)
    : null;
  let traded = 0;
  for (const fill of fills) {
    traded += Number(notionalMicro(fill.price_micro, fill.qty_base)) / 1e6;
  }
  const avgEquity = points.length
    ? points.reduce((sum, point) => sum + point.equity, 0) / points.length
    : null;
  const turnover = years && avgEquity ? traded / avgEquity / years : null;
  const exposure = points.length ? points.filter((point) => point.invested).length / points.length : 0;
  return {
    cagr: round(cagr),
    maxDrawdown: round(maxDrawdown),
    longestDrawdownBars,
    sharpe: round(sharpe),
    sortino: round(sortino),
    winRate: sells.length ? round(wins.length / sells.length) : null,
    avgWin: avg(wins, 1),
    avgLoss: avg(losses, 1),
    trades: fills.length,
    turnover: round(turnover),
    exposure: round(exposure),
    riskFreeRate: 0,
    riskFreeRateNote: 'Riskfri ränta är 0 i den här demon.',
  };
}

function closeToCloseReturn(bars) {
  if (!bars || bars.length < 2) return null;
  const first = Number(bars[0].closeMicro);
  const last = Number(bars[bars.length - 1].closeMicro);
  if (!(first > 0)) return null;
  return Math.round(((last / first) - 1) * 1e6) / 1e6;
}

module.exports = {
  computeMetrics,
  closeToCloseReturn,
};

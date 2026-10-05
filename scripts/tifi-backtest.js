const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { seedDemo } = require('../lib/tifi/seed.ts');
const { runTigerBacktest } = require('../lib/tifi/backtest.ts');
const { createSyntheticFeed } = require('../lib/paper/feeds');

const ALLOWED = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];
const WINDOW_END = '2026-01-01T00:00:00.000Z';

function parseBacktestArgs(argv) {
  let symbols = ['BTC', 'ETH', 'SOL'];
  let days = 90;
  for (const arg of argv) {
    if (arg.startsWith('--symbols=')) {
      const list = arg.slice('--symbols='.length).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
      if (!list.length || list.some((symbol) => !ALLOWED.includes(symbol))) {
        throw new Error('Symbols must be a comma list drawn from BTC, ETH, SOL, BNB, XRP.');
      }
      symbols = list;
    } else if (arg.startsWith('--days=')) {
      const daysValue = Number(arg.slice('--days='.length));
      if (!Number.isInteger(daysValue) || daysValue < 2 || daysValue > 800) {
        throw new Error('Days must be an integer from 2 to 800. The default window is 90.');
      }
      days = daysValue;
    }
  }
  const end = Date.parse(WINDOW_END);
  const from = new Date(end - (days - 1) * 86400000).toISOString();
  return { symbols, days, from, to: WINDOW_END };
}

function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

async function main(argv) {
  const args = parseBacktestArgs(argv);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tifi-backtest-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'tifi-backtest-demo',
  });
  const db = app.locals.db;
  try {
    const feed = createSyntheticFeed({ seed: 20261001, days: args.days });
    if (!feed || feed.fictional !== true || feed.id !== 'synthetic') {
      throw new Error('Refusing to run: the default feed is not the fictional paper feed.');
    }
    await seedDemo(db, { steps: 0, feed });
    const tigers = db.prepare(`
      SELECT * FROM tifi_tigers WHERE slot IN (1, 2, 3) ORDER BY slot
    `).all();
    if (tigers.length !== 3) throw new Error('Expected TIFI 1, TIFI 2 and TIFI 3.');
    const summaries = [];
    for (const tiger of tigers) {
      const row = { ...tiger, symbols_json: JSON.stringify(args.symbols) };
      const result = await runTigerBacktest(db, row, { feed, from: args.from, to: args.to });
      summaries.push({
        name: tiger.name,
        slot: tiger.slot,
        strategy: tiger.strategy,
        simulatedReturnPct: Number(formatPct(result.percent)),
        maxDrawdownPct: Number(formatPct(result.maxDrawdown)),
        trades: result.trades,
        resultLabel: result.resultLabel,
      });
    }
    console.log('DEMO paper backtest. Fictional synthetic prices. No API key. Not a forecast and not a claim of returns.');
    console.log('Window: ' + args.days + ' daily bars ending ' + args.to + '. Symbols: ' + args.symbols.join(',') + '.');
    for (const row of summaries) {
      console.log(
        row.name
        + '  ' + row.strategy
        + '  simulated return ' + formatPct(row.simulatedReturnPct) + ' %'
        + '  max drawdown ' + formatPct(row.maxDrawdownPct) + ' %'
        + '  trades ' + row.trades,
      );
    }
    console.log(JSON.stringify({
      demo: true,
      paper: true,
      network: false,
      feed: feed.id,
      fictional: true,
      symbols: args.symbols,
      days: args.days,
      from: args.from,
      to: args.to,
      tigers: summaries,
      notice: 'Simulerat resultat. Inga riktiga pengar och ingen API-nyckel. Historiken är inte en prognos.',
    }, null, 2));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { parseBacktestArgs, main };

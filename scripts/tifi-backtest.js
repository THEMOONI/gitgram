const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { seedDemo } = require('../lib/tifi/seed.ts');
const { runTigerBacktest } = require('../lib/tifi/backtest.ts');
const { createDefaultFeed } = require('../lib/paper/feeds');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tifi-backtest-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'tifi-backtest-demo',
  });
  const db = app.locals.db;
  try {
    const feed = createDefaultFeed({});
    if (!feed || feed.fictional !== true || feed.id !== 'synthetic') {
      throw new Error('Refusing to run: the default feed is not the fictional paper feed.');
    }
    await seedDemo(db, { steps: 0, feed });
    const tiger = db.prepare('SELECT * FROM tifi_tigers ORDER BY slot LIMIT 1').get();
    if (!tiger) throw new Error('No paper tiger to backtest.');
    const result = await runTigerBacktest(db, tiger, { feed });
    console.log(JSON.stringify({
      demo: true,
      paper: true,
      network: false,
      feed: feed.id,
      fictional: true,
      tiger: tiger.name,
      percent: result.percent,
      resultLabel: result.resultLabel,
      runId: result.runId,
      notice: 'Simulerat resultat. Inga riktiga pengar och ingen API-nyckel.',
    }, null, 2));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

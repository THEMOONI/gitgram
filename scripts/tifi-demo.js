const path = require('path');
const { createApp } = require('../server');
const { seedDemo } = require('../lib/tifi/seed.ts');

async function main() {
  const dbPath = process.env.GITGRAM_DB || path.join(__dirname, '..', 'db', 'gitgram.db');
  const app = createApp({
    dbPath,
    sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-session-secret',
  });
  const result = await seedDemo(app.locals.db, {});
  console.log('TIFI demo seed');
  console.log('  user: tifi');
  console.log('  password: tifi-demo');
  console.log('  owner password: tigerpapper-2026');
  console.log('  url: http://127.0.0.1:8792/tifi');
  console.log('  already: ' + !!result.already);
  app.locals.db.close();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

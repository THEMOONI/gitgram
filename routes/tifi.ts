const { DEMO_NOTICE, SIMULATED_RESULT } = require('../lib/demo-notice') as {
  DEMO_NOTICE: string;
  SIMULATED_RESULT: string;
};
const { parseAmountToMinor } = require('../lib/ledger') as {
  parseAmountToMinor: (input: string, opts?: any) => any;
};
const { TifiError } = require('../lib/tifi/errors.ts') as {
  TifiError: new (code: string, message: string, status?: number) => Error & { code: string; status: number };
};
const { assertOwnerPassword } = require('../lib/tifi/auth.ts') as {
  assertOwnerPassword: (db: any, userId: number, password: string, clock?: () => Date) => void;
};
const { loadBoard, worldPanel } = require('../lib/tifi/board.ts') as {
  loadBoard: (db: any, userId: number) => any;
  worldPanel: (db: any, userId: number, snapshot: any, now: Date, env?: any) => any;
};
const { subscribe } = require('../lib/tifi/events.ts') as { subscribe: (fn: (event: any) => void) => () => void };
const { moveCash, listTigers, setTigerVenue } = require('../lib/tifi/treasury.ts') as {
  moveCash: (db: any, args: any) => void;
  listTigers: (db: any, userId: number) => any[];
  setTigerVenue: (db: any, userId: number, tigerId: number, venue: string) => void;
};
const { setRunning, stepUser, startScheduler } = require('../lib/tifi/runner.ts') as {
  setRunning: (db: any, userId: number, running: boolean, clock?: () => Date) => any;
  stepUser: (db: any, userId: number, opts?: any) => Promise<any>;
  startScheduler: (db: any, opts?: any) => () => void;
};
const { createTiger } = require('../lib/tifi/treasury.ts') as {
  createTiger: (db: any, userId: number, config: any, slot: number | null, clock?: () => Date) => number;
};
const { parseTigerSentence } = require('../lib/tifi/parser.ts') as { parseTigerSentence: (text: string, opts?: any) => any };
const setup = require('../lib/tifi/setup.ts') as any;
const { runTigerBacktest } = require('../lib/tifi/backtest.ts') as { runTigerBacktest: (db: any, row: any, opts: any) => Promise<any> };
const engine = require('../lib/paper/engine');
const { createWorldFeed } = require('../lib/tifi/world-feed.ts') as {
  createWorldFeed: (env?: any, opts?: any) => any;
};
const { markOpenToFeed } = require('../lib/tifi/world-venue.ts') as {
  markOpenToFeed: (db: any, userId: number, markets: any[]) => void;
};

function envelope(body: any): any {
  return {
    ...body,
    demo: true,
    notice: DEMO_NOTICE,
    simulated: true,
    resultLabel: SIMULATED_RESULT,
    product: 'TIFI (Tiger Finance)',
  };
}

module.exports = function tifiRoutes(db: any, options: any = {}) {
  const express = require('express');
  const router = express.Router();
  const clock = options.clock || (() => new Date());
  const feed = options.priceFeed;
  if (options.autoRun) startScheduler(db, { feed, clock, tickMs: options.tickMs || 5000 });

  function requireUser(req: any, res: any, next: any) {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.locals.navTifi = true;
    if (!req.session.userId) return res.redirect('/login');
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.redirect('/login');
    req.tifiUser = user;
    next();
  }

  function flash(req: any): any {
    const value = req.session.tifiFlash || null;
    if (value) delete req.session.tifiFlash;
    return value;
  }

  function fail(req: any, res: any, err: any, next: any, redirect: string) {
    if (err instanceof TifiError || (err && err.name === 'TifiError') || (err && err.name === 'PaperError') || (err && err.name === 'LedgerError')) {
      req.session.tifiFlash = { error: err.message, code: err.code };
      return req.session.save(() => res.redirect(redirect));
    }
    return next(err);
  }

  function page(res: any, view: string, model: any) {
    res.render(view, {
      title: 'TIFI (Tiger Finance)',
      notice: DEMO_NOTICE,
      simulatedLabel: SIMULATED_RESULT,
      navTifi: true,
      ...model,
    });
  }

  async function boardFor(userId: number): Promise<any> {
    const now = clock();
    let snapshot: any = {
      markets: [],
      source: 'simulated',
      live: false,
      fetchedAt: now.toISOString(),
      note: null,
    };
    try {
      const feed = createWorldFeed(process.env, { fetchImpl: globalThis.fetch, now: clock });
      snapshot = await feed.listActive();
      markOpenToFeed(db, userId, snapshot.markets || []);
    } catch {
      snapshot.note = 'Flödet kunde inte läsas. Visar det simulerade flödet.';
    }
    const board = loadBoard(db, userId);
    board.world = worldPanel(db, userId, snapshot, now, process.env);
    return board;
  }

  router.get('/tifi/api/state', requireUser, async (req: any, res: any) => {
    const row = setup.setupRow(db, req.tifiUser.id);
    if (!row || !row.finished_at) return res.status(409).json(envelope({ error: 'setup', message: 'Installningen är inte klar.' }));
    res.json(envelope({ board: await boardFor(req.tifiUser.id) }));
  });

  router.get('/tifi/events', requireUser, (req: any, res: any) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write('data: ' + JSON.stringify({ type: 'hello', notice: DEMO_NOTICE, simulated: true }) + '\n\n');
    const off = subscribe((event) => {
      if (event.userId !== req.tifiUser.id) return;
      res.write('data: ' + JSON.stringify({ ...event, notice: DEMO_NOTICE, simulated: true }) + '\n\n');
    });
    const beat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(beat);
      off();
    });
  });

  router.get('/tifi/setup', requireUser, (req: any, res: any) => {
    const row = setup.setupRow(db, req.tifiUser.id);
    if (row && row.finished_at) return res.redirect('/tifi');
    const note = flash(req);
    const order = ['risk', 'password', 'design'];
    let step = setup.setupStep(db, req.tifiUser.id);
    const asked = String(req.query.step || '');
    if (order.includes(asked) && order.indexOf(asked) < order.indexOf(step)) step = asked;
    const drafts = setup.drafts(db, req.tifiUser.id);
    page(res, 'tifi/setup', {
      step,
      drafts,
      ready: drafts.every((draft: any) => draft.confirmed && draft.config),
      formError: note && note.error,
      formOk: note && note.ok,
    });
  });

  router.post('/tifi/setup/risk', requireUser, (req: any, res: any, next: any) => {
    try {
      if (req.body.c1 !== '1' || req.body.c2 !== '1' || req.body.c3 !== '1') {
        throw new TifiError('RISK', 'Kryssa i alla tre för att fortsätta.');
      }
      setup.acceptRisk(db, req.tifiUser.id, clock);
      return req.session.save(() => res.redirect('/tifi/setup'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/setup');
    }
  });

  router.post('/tifi/setup/password', requireUser, (req: any, res: any, next: any) => {
    try {
      if (req.body.password !== req.body.password_again) {
        throw new TifiError('WEAK_PASSWORD', 'Lösenorden matchar inte.');
      }
      setup.setOwnerPassword(db, req.tifiUser.id, String(req.body.password || ''), clock);
      return req.session.save(() => res.redirect('/tifi/setup'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/setup');
    }
  });

  router.post('/tifi/setup/parse', requireUser, (req: any, res: any, next: any) => {
    try {
      const parsed = setup.saveDraft(db, req.tifiUser.id, Number(req.body.slot), String(req.body.sentence || ''));
      const notes = parsed.notes && parsed.notes.length ? ' ' + parsed.notes.join(' ') : '';
      req.session.tifiFlash = { ok: 'Konfigurationen är tolkad. Bekräfta den innan tigern skapas.' + notes };
      return req.session.save(() => res.redirect('/tifi/setup'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/setup');
    }
  });

  router.post('/tifi/setup/confirm', requireUser, (req: any, res: any, next: any) => {
    try {
      setup.confirmDraft(db, req.tifiUser.id, Number(req.body.slot));
      req.session.tifiFlash = { ok: 'Tigern är bekräftad. Inga riktiga pengar rörs.' };
      return req.session.save(() => res.redirect('/tifi/setup'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/setup');
    }
  });

  router.post('/tifi/setup/portrait', requireUser, (req: any, res: any, next: any) => {
    try {
      setup.cyclePortrait(db, req.tifiUser.id, Number(req.body.slot));
      return req.session.save(() => res.redirect('/tifi/setup'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/setup');
    }
  });

  router.post('/tifi/setup/finish', requireUser, (req: any, res: any, next: any) => {
    try {
      setup.finishSetup(db, req.tifiUser.id, clock);
      req.session.tifiFlash = { ok: 'Kassan är fylld med simulerade DEMO och de tre tigrarna är igång.' };
      return req.session.save(() => res.redirect('/tifi'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/setup');
    }
  });

  router.get('/bots', requireUser, (_req: any, res: any) => {
    res.redirect('/tifi');
  });

  router.get('/tifi', requireUser, async (req: any, res: any) => {
    const row = setup.setupRow(db, req.tifiUser.id);
    if (!row || !row.finished_at) return res.redirect('/tifi/setup');
    const note = flash(req);
    page(res, 'tifi/dashboard', {
      board: await boardFor(req.tifiUser.id),
      formError: note && note.error,
      formOk: note && note.ok,
      username: req.tifiUser.username,
    });
  });

  router.get('/tifi/tigers', requireUser, (req: any, res: any) => {
    const note = flash(req);
    const pending = req.session.tifiPending || null;
    page(res, 'tifi/tigers', {
      tigers: listTigers(db, req.tifiUser.id),
      pending,
      formError: note && note.error,
      formOk: note && note.ok,
    });
  });

  router.post('/tifi/tigers/parse', requireUser, (req: any, res: any, next: any) => {
    try {
      const parsed = parseTigerSentence(String(req.body.sentence || ''), { name: String(req.body.name || '').trim() || null });
      if (!parsed.ok) throw new TifiError('PARSE', parsed.errors.join(' '));
      req.session.tifiPending = { sentence: String(req.body.sentence || ''), config: parsed.config, notes: parsed.notes };
      req.session.tifiFlash = { ok: 'Tolkat. Bekräfta konfigurationen innan tigern skapas.' };
      return req.session.save(() => res.redirect('/tifi/tigers'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/tigers');
    }
  });

  router.post('/tifi/tigers', requireUser, (req: any, res: any, next: any) => {
    try {
      const pending = req.session.tifiPending;
      if (!pending || !pending.config) throw new TifiError('PARSE', 'Tolka meningen och bekräfta konfigurationen först.');
      if (req.body.confirm !== '1') throw new TifiError('CONFIRM', 'Bekräfta konfigurationen först.');
      const count = db.prepare('SELECT COUNT(*) AS n FROM tifi_tigers WHERE user_id = ?').get(req.tifiUser.id).n;
      pending.config.name = pending.config.name && pending.config.name !== 'Tiger'
        ? pending.config.name
        : 'Tiger ' + (count + 1);
      createTiger(db, req.tifiUser.id, pending.config, null, clock);
      delete req.session.tifiPending;
      req.session.tifiFlash = { ok: 'Tigern är skapad i pappersläget. Flytta simulerad kassa från kassan om den ska handla.' };
      return req.session.save(() => res.redirect('/tifi/tigers'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/tigers');
    }
  });

  router.post('/tifi/tigers/:id/venue', requireUser, (req: any, res: any, next: any) => {
    try {
      assertOwnerPassword(db, req.tifiUser.id, String(req.body.owner_password || ''), clock);
      const tiger = ownedTiger(req);
      const venue = String(req.body.venue || '');
      setTigerVenue(db, req.tifiUser.id, tiger.id, venue);
      const label = venue === 'paper' ? 'pappersmarknaden' : 'World-marknader (papper)';
      req.session.tifiFlash = { ok: tiger.name + ' handlar nu på ' + label + '. Inga riktiga pengar.' };
      return req.session.save(() => res.redirect('/tifi'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi');
    }
  });

  router.post('/tifi/tigers/:id/pause', requireUser, (req: any, res: any, next: any) => {
    try {
      const tiger = ownedTiger(req);
      engine.pausePortfolio(db, {
        portfolioId: tiger.portfolio_id,
        actor: { type: 'user', id: 'user:' + req.tifiUser.id, userId: req.tifiUser.id },
        clock,
      });
      db.prepare(`UPDATE tifi_tigers SET status = 'paused', pause_reason = 'owner' WHERE id = ?`).run(tiger.id);
      req.session.tifiFlash = { ok: tiger.name + ' är pausad.' };
      return req.session.save(() => res.redirect('/tifi'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi');
    }
  });

  router.post('/tifi/tigers/:id/resume', requireUser, (req: any, res: any, next: any) => {
    try {
      assertOwnerPassword(db, req.tifiUser.id, String(req.body.owner_password || ''), clock);
      const tiger = ownedTiger(req);
      const state = engine.readState(db, tiger.portfolio_id);
      if (state && state.portfolio.status === 'paused') {
        engine.resumePortfolio(db, {
          portfolioId: tiger.portfolio_id,
          actor: { type: 'user', id: 'user:' + req.tifiUser.id, userId: req.tifiUser.id },
          clock,
        });
      }
      db.prepare(`UPDATE tifi_tigers SET status = 'active', pause_reason = NULL WHERE id = ?`).run(tiger.id);
      req.session.tifiFlash = { ok: tiger.name + ' är återupptagen av ägaren.' };
      return req.session.save(() => res.redirect('/tifi'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi');
    }
  });

  router.post('/tifi/tigers/:id/backtest', requireUser, async (req: any, res: any, next: any) => {
    try {
      const tiger = ownedTiger(req);
      const result = await runTigerBacktest(db, tiger, { feed, clock });
      req.session.tifiFlash = {
        ok: 'Simulerat resultat för ' + tiger.name + ': ' + result.percent.toFixed(2) + ' %. ' + SIMULATED_RESULT,
      };
      return req.session.save(() => res.redirect('/tifi/tigers'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi/tigers');
    }
  });

  router.post('/tifi/treasury/move', requireUser, (req: any, res: any, next: any) => {
    try {
      assertOwnerPassword(db, req.tifiUser.id, String(req.body.owner_password || ''), clock);
      const parsed = parseAmountToMinor(String(req.body.amount || ''), { maxMinor: 100000 });
      if (!parsed.ok) throw new TifiError(parsed.code, parsed.message);
      const key = 'tifi-move-' + req.tifiUser.id + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      moveCash(db, {
        userId: req.tifiUser.id,
        fromRef: String(req.body.from || ''),
        toRef: String(req.body.to || ''),
        amountMinor: parsed.minor,
        idempotencyKey: key,
        clock,
      });
      req.session.tifiFlash = { ok: 'Simulerad flytt bokförd. Inga riktiga pengar.' };
      return req.session.save(() => res.redirect('/tifi'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi');
    }
  });

  router.post('/tifi/runner/:action', requireUser, async (req: any, res: any, next: any) => {
    try {
      const action = String(req.params.action || '');
      if (action === 'start') setRunning(db, req.tifiUser.id, true, clock);
      else if (action === 'stop') setRunning(db, req.tifiUser.id, false, clock);
      else if (action === 'step') await stepUser(db, req.tifiUser.id, { feed, clock, force: true, env: process.env });
      else throw new TifiError('ACTION', 'Okänd åtgärd.');
      return req.session.save(() => res.redirect('/tifi'));
    } catch (err) {
      return fail(req, res, err, next, '/tifi');
    }
  });

  router.post('/tifi/consent', requireUser, (req: any, res: any) => {
    const choice = req.body.choice === 'approve' ? 'approve' : 'reject';
    req.session.tifiConsent = {
      choice,
      analytics: choice === 'approve' && req.body.analytics === '1',
      voice: choice === 'approve' && req.body.voice === '1',
    };
    return req.session.save(() => res.redirect('/tifi'));
  });

  function ownedTiger(req: any): any {
    const tiger = db.prepare('SELECT * FROM tifi_tigers WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.tifiUser.id);
    if (!tiger) throw new TifiError('NOT_FOUND', 'Tigern finns inte.', 404);
    return tiger;
  }

  return router;
};

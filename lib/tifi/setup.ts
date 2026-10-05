const { TifiError, iso } = require('./errors.ts') as {
  TifiError: new (code: string, message: string, status?: number) => Error;
  iso: (clock?: () => Date) => string;
};
const { hashOwnerPassword } = require('./auth.ts') as { hashOwnerPassword: (password: string) => { salt: string; hash: string } };
const { parseTigerSentence } = require('./parser.ts') as { parseTigerSentence: (text: string, opts?: any) => any };
const { fundTreasury, createTiger, allocateToSlots, getTreasury } = require('./treasury.ts') as {
  fundTreasury: (db: any, args: any) => any;
  createTiger: (db: any, userId: number, config: any, slot: number | null, clock?: () => Date) => number;
  allocateToSlots: (db: any, userId: number, key: string, clock?: () => Date) => number[];
  getTreasury: (db: any, userId: number) => any;
};
const { DEFAULT_SENTENCES } = require('./seed.ts') as { DEFAULT_SENTENCES: string[] };
const { setRunning } = require('./runner.ts') as { setRunning: (db: any, userId: number, running: boolean, clock?: () => Date) => any };

function setupRow(db: any, userId: number): any {
  return db.prepare('SELECT * FROM tifi_setup WHERE user_id = ?').get(userId) || null;
}

function ensureSetup(db: any, userId: number, clock?: () => Date): any {
  const row = setupRow(db, userId);
  if (row) return row;
  db.prepare('INSERT INTO tifi_setup (user_id, created_at) VALUES (?, ?)').run(userId, iso(clock));
  return setupRow(db, userId);
}

function acceptRisk(db: any, userId: number, clock?: () => Date): void {
  ensureSetup(db, userId, clock);
  db.prepare('UPDATE tifi_setup SET risk_accepted_at = ? WHERE user_id = ?').run(iso(clock), userId);
}

function setOwnerPassword(db: any, userId: number, password: string, clock?: () => Date): void {
  const row = ensureSetup(db, userId, clock);
  if (!row.risk_accepted_at) throw new TifiError('RISK', 'Godkänn villkoren först.');
  const secret = hashOwnerPassword(password);
  db.prepare('UPDATE tifi_setup SET password_salt = ?, password_hash = ? WHERE user_id = ?').run(secret.salt, secret.hash, userId);
}

function drafts(db: any, userId: number): any[] {
  const rows = db.prepare('SELECT * FROM tifi_drafts WHERE user_id = ? ORDER BY slot').all(userId);
  const bySlot = new Map<number, any>();
  for (const row of rows) bySlot.set(row.slot, row);
  return [1, 2, 3].map((slot) => {
    const row = bySlot.get(slot);
    return {
      slot,
      sentence: row ? row.sentence : DEFAULT_SENTENCES[slot - 1],
      config: row && row.config_json ? JSON.parse(row.config_json) : null,
      notes: [],
      variant: row && row.portrait_variant ? row.portrait_variant : 0,
      confirmed: !!(row && row.confirmed),
    };
  });
}

function saveDraft(db: any, userId: number, slot: number, sentence: string): any {
  if (![1, 2, 3].includes(slot)) throw new TifiError('SLOT', 'Välj TIFI 1, TIFI 2 eller TIFI 3.');
  const parsed = parseTigerSentence(sentence, { slot });
  if (!parsed.ok) throw new TifiError('PARSE', parsed.errors.join(' '));
  parsed.config.portraitVariant = 0;
  db.prepare(`
    INSERT INTO tifi_drafts (user_id, slot, sentence, config_json, portrait_variant, confirmed)
    VALUES (?, ?, ?, ?, 0, 0)
    ON CONFLICT(user_id, slot) DO UPDATE SET
      sentence = excluded.sentence,
      config_json = excluded.config_json,
      portrait_variant = 0,
      confirmed = 0
  `).run(userId, slot, sentence, JSON.stringify(parsed.config));
  return parsed;
}

function confirmDraft(db: any, userId: number, slot: number): void {
  const row = db.prepare('SELECT config_json FROM tifi_drafts WHERE user_id = ? AND slot = ?').get(userId, slot);
  if (!row || !row.config_json) throw new TifiError('PARSE', 'Skapa konfigurationen innan du bekräftar.');
  db.prepare('UPDATE tifi_drafts SET confirmed = 1 WHERE user_id = ? AND slot = ?').run(userId, slot);
}

function cyclePortrait(db: any, userId: number, slot: number): number {
  if (![1, 2, 3].includes(slot)) throw new TifiError('SLOT', 'Välj TIFI 1, TIFI 2 eller TIFI 3.');
  const row = db.prepare('SELECT config_json FROM tifi_drafts WHERE user_id = ? AND slot = ?').get(userId, slot);
  if (!row || !row.config_json) throw new TifiError('PARSE', 'Skapa tigern innan du genererar porträttet.');
  const config = JSON.parse(row.config_json);
  config.portraitVariant = slot;
  db.prepare(`
    UPDATE tifi_drafts
    SET portrait_variant = ?, confirmed = 1, config_json = ?
    WHERE user_id = ? AND slot = ?
  `).run(slot, JSON.stringify(config), userId, slot);
  return slot;
}

function finishSetup(db: any, userId: number, clock?: () => Date): void {
  const row = ensureSetup(db, userId, clock);
  if (!row.risk_accepted_at) throw new TifiError('RISK', 'Godkänn villkoren först.');
  if (!row.password_hash) throw new TifiError('PASSWORD', 'Välj ett ägarlösenord först.');
  const ready = drafts(db, userId);
  if (ready.some((draft) => !draft.confirmed || !draft.config)) {
    throw new TifiError('DRAFT', 'Bekräfta alla tre tigrarna först.');
  }
  if (!getTreasury(db, userId)) {
    fundTreasury(db, {
      userId,
      amountMinor: 100000,
      idempotencyKey: 'tifi-fund-' + userId,
      clock,
    });
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM tifi_tigers WHERE user_id = ?').get(userId).n;
  if (!count) {
    for (const draft of ready) {
      draft.config.portraitVariant = draft.variant;
      createTiger(db, userId, draft.config, draft.slot, clock);
    }
    allocateToSlots(db, userId, 'tifi-split-' + userId, clock);
  }
  setRunning(db, userId, true, clock);
  db.prepare('UPDATE tifi_setup SET finished_at = ? WHERE user_id = ?').run(iso(clock), userId);
}

function setupStep(db: any, userId: number): string {
  const row = setupRow(db, userId);
  if (!row || !row.risk_accepted_at) return 'risk';
  if (!row.password_hash) return 'password';
  return 'design';
}

module.exports = {
  setupRow,
  acceptRisk,
  setOwnerPassword,
  drafts,
  saveDraft,
  confirmDraft,
  cyclePortrait,
  finishSetup,
  setupStep,
};

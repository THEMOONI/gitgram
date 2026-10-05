const crypto = require('crypto');
const express = require('express');
const { isValidUsername } = require('../lib/validate');
const {
  DISCLAIMER,
  UNIT_LABEL,
  FAUCET_HANDLE,
  MAX_TRANSFER_MINOR,
  LedgerError,
  formatMinor,
  parseAmountToMinor,
  normalizeMemo,
  isIdempotencyKey,
  issueWelcomeGrant,
  transferBetweenUsers,
  getWallet,
  readWallet,
  getAccountByUserId,
  presentEntry,
} = require('../lib/ledger');

const DISPLAY_USD_NUMERATOR = 1284;
const DISPLAY_USD_DENOMINATOR = 1000;

function illustrativeUsd(minor) {
  const usdCents = Math.round((minor * DISPLAY_USD_NUMERATOR) / DISPLAY_USD_DENOMINATOR);
  return formatMinor(usdCents);
}

function wantsJson(req) {
  const type = req.get('content-type') || '';
  const accept = req.get('accept') || '';
  return type.includes('application/json') || accept.includes('application/json');
}

function isApi(req) {
  return req.path === '/api/wallet' || req.path.startsWith('/api/wallet/');
}

function normalizeRecipient(input) {
  if (typeof input !== 'string') return '';
  return input.trim().replace(/^@+/, '').trim();
}

function formatPlainMinor(minor) {
  const abs = Math.abs(minor);
  return Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function emptyCopy(flow, historyLength) {
  if (historyLength > 0) return null;
  if (flow === 'out') {
    return {
      title: 'No outgoing demo transfers yet',
      body: 'Send demo tokens to a teammate to see them here.',
      claim: false,
    };
  }
  if (flow === 'in') {
    return {
      title: 'No incoming demo transfers yet',
      body: 'Incoming demo transfers, including the welcome grant, show up here.',
      claim: false,
    };
  }
  return {
    title: 'No demo transactions yet',
    body: 'Send tokens to a teammate or claim the welcome grant to see activity here.',
    claim: true,
  };
}

module.exports = function walletRoutes(db) {
  const router = express.Router();

  function requireUser(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!req.session.userId) {
      if (isApi(req) || wantsJson(req)) {
        return res.status(401).json({
          demo: true,
          disclaimer: DISCLAIMER,
          error: 'login_required',
          message: 'Login required.',
        });
      }
      return res.redirect('/login');
    }
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.redirect('/login');
    req.walletUser = user;
    next();
  }

  function takeFlash(req) {
    const flash = req.session.walletFlash || null;
    if (flash) delete req.session.walletFlash;
    return flash;
  }

  function viewModel(user, flow, form, flash) {
    const wallet = readWallet(db, user.id, flow);
    const rows = wallet.history.map(presentEntry);
    const grantRow = db.prepare(`
      SELECT id FROM ledger_transfers WHERE idempotency_key = ?
    `).get('grant:user:' + user.id);
    const empty = emptyCopy(wallet.flow, rows.length);
    if (empty && grantRow) empty.claim = false;
    const parsedMinor = form.amountResult && form.amountResult.ok ? form.amountResult.minor : null;
    const summaryReady = parsedMinor != null && !form.amountError && parsedMinor <= wallet.balanceMinor;
    const summarySend = summaryReady ? formatMinor(parsedMinor) : null;
    const summaryAfter = summaryReady ? formatMinor(wallet.balanceMinor - parsedMinor) : null;
    return {
      title: 'Wallet (demo) - GITGRAM',
      navWallet: true,
      disclaimer: DISCLAIMER,
      unitLabel: UNIT_LABEL,
      username: user.username,
      walletId: 'demo:' + user.username,
      balanceMinor: wallet.balanceMinor,
      balance: formatMinor(wallet.balanceMinor),
      usd: illustrativeUsd(wallet.balanceMinor),
      received: formatMinor(wallet.received30dMinor),
      sent: formatMinor(wallet.sent30dMinor),
      pending: formatMinor(0),
      maxTransfer: formatMinor(MAX_TRANSFER_MINOR),
      flow: wallet.flow,
      rows,
      empty,
      hasGrant: !!grantRow,
      showClaim: !!(empty && empty.claim && !grantRow),
      flash,
      idempotencyKey: form.idempotencyKey,
      recipient: form.recipient,
      amount: form.amount,
      memo: form.memo,
      recipientError: form.recipientError,
      amountError: form.amountError,
      memoError: form.memoError,
      formError: form.formError,
      recipientOk: form.recipientOk,
      recipientFound: form.recipientFound,
      blockSubmit: !!(form.recipientError || form.amountError || form.memoError || form.formError),
      summarySend,
      summaryAfter,
      memoCount: form.memo.length,
      faucetHandle: FAUCET_HANDLE,
    };
  }

  function blankForm() {
    return {
      recipient: '',
      amount: '',
      memo: '',
      idempotencyKey: crypto.randomUUID(),
      amountResult: null,
      recipientError: null,
      amountError: null,
      memoError: null,
      formError: null,
      recipientOk: false,
      recipientFound: null,
    };
  }

  function renderWallet(req, res, status, form, flash) {
    res.locals.navWallet = true;
    res.status(status).render('wallet', viewModel(req.walletUser, req.query.flow, form, flash));
  }

  function fieldError(code, message, field) {
    const body = {
      demo: true,
      disclaimer: DISCLAIMER,
      error: code,
      message,
      fields: {},
    };
    if (field) body.fields[field] = message;
    return body;
  }

  router.get('/wallet', requireUser, (req, res) => {
    issueWelcomeGrant(db, req.walletUser.id);
    renderWallet(req, res, 200, blankForm(), takeFlash(req));
  });

  router.get('/wallet/export.csv', requireUser, (req, res) => {
    const wallet = getWallet(db, req.walletUser.id, 'all');
    const lines = [
      '# ' + DISCLAIMER,
      'direction,counterparty,memo,amount_ggt_demo,amount_minor,created_at',
    ];
    wallet.history.slice().reverse().forEach((row) => {
      const entry = presentEntry(row);
      lines.push([
        entry.direction,
        entry.username,
        entry.memo,
        formatPlainMinor(Math.abs(entry.amountMinor)),
        String(entry.amountMinor),
        entry.createdAt,
      ].map(csvEscape).join(','));
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="gitgram-demo-wallet.csv"');
    res.send(lines.join('\n') + '\n');
  });

  router.post('/wallet/grant', requireUser, (req, res) => {
    issueWelcomeGrant(db, req.walletUser.id);
    if (wantsJson(req)) {
      const wallet = getWallet(db, req.walletUser.id, 'all');
      return res.json({
        demo: true,
        disclaimer: DISCLAIMER,
        status: 'granted',
        balanceMinor: wallet.balanceMinor,
        balanceDisplay: formatMinor(wallet.balanceMinor) + ' ' + UNIT_LABEL,
      });
    }
    res.redirect('/wallet');
  });

  router.post('/wallet/transfer', requireUser, (req, res) => {
    const json = wantsJson(req);
    const recipientInput = normalizeRecipient(req.body && req.body.recipient);
    const amountInput = req.body ? req.body.amount : undefined;
    const memoInput = req.body ? (req.body.memo != null ? req.body.memo : req.body.message) : undefined;
    const keyInput = (req.body && req.body.idempotency_key) || req.get('Idempotency-Key');
    const amountResult = parseAmountToMinor(typeof amountInput === 'string' ? amountInput : '');
    const memoResult = normalizeMemo(memoInput);
    const form = {
      recipient: recipientInput,
      amount: typeof amountInput === 'string' ? amountInput : '',
      memo: memoResult.ok ? memoResult.memo : (typeof memoInput === 'string' ? memoInput.slice(0, 180) : ''),
      idempotencyKey: typeof keyInput === 'string' && isIdempotencyKey(keyInput) ? keyInput : crypto.randomUUID(),
      amountResult,
      recipientError: null,
      amountError: amountResult.ok ? null : amountResult.message,
      memoError: memoResult.ok ? null : memoResult.message,
      formError: null,
      recipientOk: false,
      recipientFound: null,
    };

    function fail(code, message, field) {
      if (field === 'recipient') form.recipientError = message;
      if (field === 'amount') form.amountError = message;
      if (field === 'memo') form.memoError = message;
      if (!field) form.formError = message;
      if (json) return res.status(code === 'idempotency_conflict' ? 409 : 400).json(fieldError(code, message, field));
      return renderWallet(req, res, code === 'idempotency_conflict' ? 409 : 400, form, null);
    }

    if (!isIdempotencyKey(typeof keyInput === 'string' ? keyInput : '')) {
      return fail('idempotency_key', 'Missing or invalid idempotency key.', null);
    }
    form.idempotencyKey = keyInput;
    if (!memoResult.ok) return fail(memoResult.code, memoResult.message, 'memo');
    if (!amountResult.ok) return fail(amountResult.code, amountResult.message, 'amount');
    if (!recipientInput) return fail('unknown_recipient', 'Enter a Gitgram username.', 'recipient');
    if (!isValidUsername(recipientInput)) {
      return fail('unknown_recipient', 'No Gitgram user named @' + recipientInput.slice(0, 39), 'recipient');
    }
    const recipient = db.prepare('SELECT id, username FROM users WHERE username = ?').get(recipientInput);
    if (!recipient) {
      return fail('unknown_recipient', 'No Gitgram user named @' + recipientInput, 'recipient');
    }
    if (recipient.id === req.walletUser.id) {
      return fail('self', "You can't send demo tokens to yourself.", 'recipient');
    }
    form.recipientOk = true;
    form.recipientFound = recipient.username;

    try {
      const result = transferBetweenUsers(db, {
        fromUserId: req.walletUser.id,
        toUserId: recipient.id,
        amountMinor: amountResult.minor,
        memo: memoResult.memo,
        idempotencyKey: keyInput,
      });
      const after = getAccountByUserId(db, req.walletUser.id);
      const payload = {
        demo: true,
        disclaimer: DISCLAIMER,
        status: result.outcome,
        transferId: result.transferId,
        recipient: recipient.username,
        amountMinor: amountResult.minor,
        amountDisplay: formatMinor(amountResult.minor) + ' ' + UNIT_LABEL,
        balanceMinor: after.balance_minor,
        balanceDisplay: formatMinor(after.balance_minor) + ' ' + UNIT_LABEL,
      };
      if (json) return res.status(result.outcome === 'created' ? 201 : 200).json(payload);
      req.session.walletFlash = {
        amount: formatMinor(amountResult.minor),
        recipient: recipient.username,
        balance: formatMinor(after.balance_minor),
        transferId: result.transferId,
      };
      return res.redirect('/wallet#tx-' + result.transferId);
    } catch (err) {
      if (err instanceof LedgerError) {
        const field = err.code === 'insufficient_funds' || err.code === 'too_large' ? 'amount'
          : err.code === 'self' || err.code === 'unknown_recipient' ? 'recipient'
            : null;
        if (json) {
          return res.status(err.status).json(fieldError(err.code, err.message, field));
        }
        if (field === 'amount') form.amountError = err.message;
        else if (field === 'recipient') form.recipientError = err.message;
        else form.formError = err.message;
        return renderWallet(req, res, err.status, form, null);
      }
      throw err;
    }
  });

  router.get('/api/wallet/lookup', requireUser, (req, res) => {
    const username = normalizeRecipient(req.query.username);
    if (!username || !isValidUsername(username)) {
      return res.json({ demo: true, disclaimer: DISCLAIMER, found: false });
    }
    const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
    if (!user) return res.json({ demo: true, disclaimer: DISCLAIMER, found: false, username });
    res.json({
      demo: true,
      disclaimer: DISCLAIMER,
      found: true,
      username: user.username,
      self: user.id === req.walletUser.id,
    });
  });

  router.get('/api/wallet', requireUser, (req, res) => {
    const wallet = getWallet(db, req.walletUser.id, req.query.flow);
    res.json({
      demo: true,
      disclaimer: DISCLAIMER,
      unit: 'GGT',
      unitLabel: UNIT_LABEL,
      walletId: 'demo:' + req.walletUser.username,
      username: req.walletUser.username,
      balanceMinor: wallet.balanceMinor,
      balanceDisplay: formatMinor(wallet.balanceMinor) + ' ' + UNIT_LABEL,
      received30dMinor: wallet.received30dMinor,
      received30dDisplay: formatMinor(wallet.received30dMinor) + ' ' + UNIT_LABEL,
      sent30dMinor: wallet.sent30dMinor,
      sent30dDisplay: formatMinor(wallet.sent30dMinor) + ' ' + UNIT_LABEL,
      pendingMinor: 0,
      pendingDisplay: '0.00 ' + UNIT_LABEL,
      notConvertible: true,
      flow: wallet.flow,
      history: wallet.history.map((row) => {
        const entry = presentEntry(row);
        return {
          id: entry.id,
          direction: entry.direction,
          counterparty: entry.username,
          counterpartyKind: entry.isSystem ? 'system' : 'user',
          memo: entry.memo,
          amountMinor: entry.amountMinor,
          amountDisplay: entry.amountDisplay,
          createdAt: entry.createdAt,
        };
      }),
    });
  });

  return router;
};

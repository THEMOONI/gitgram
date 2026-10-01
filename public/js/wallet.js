const TOAST_DISMISS_MS = 6000;
const SENDING_LABEL = 'Sending\u2026 (simulated)';
const MAX_TRANSFER_MINOR = 50000;

function formatMinorUnits(minor) {
  const abs = Math.abs(minor);
  const frac = String(abs % 100).padStart(2, '0');
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return whole + '.' + frac;
}

function classifyAmount(input, balanceMinor, maxMinor) {
  const max = maxMinor == null ? MAX_TRANSFER_MINOR : maxMinor;
  if (typeof input !== 'string') return { ok: false, code: 'invalid_amount' };
  const raw = input.trim();
  if (!raw || /[eE+]/.test(raw)) return { ok: false, code: 'invalid_amount' };
  let negative = false;
  let body = raw;
  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1);
  }
  if (body.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body)) return { ok: false, code: 'invalid_amount' };
    body = body.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(body)) return { ok: false, code: 'invalid_amount' };
  const parts = body.split('.');
  if ((parts[1] || '').length > 2) return { ok: false, code: 'non_integer_cents' };
  if (parts[0].length > 7) return { ok: false, code: 'too_large' };
  const minor = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
  if (!Number.isSafeInteger(minor)) return { ok: false, code: 'too_large' };
  if (negative) return { ok: false, code: minor === 0 ? 'zero' : 'negative' };
  if (minor === 0) return { ok: false, code: 'zero' };
  if (minor > max) return { ok: false, code: 'too_large' };
  if (typeof balanceMinor === 'number' && minor > balanceMinor) return { ok: false, code: 'insufficient_funds', minor };
  return { ok: true, minor };
}

function amountMessage(code, balanceMinor) {
  if (code === 'non_integer_cents') return 'Amount must be a whole number of cents (demo), with at most two decimal places.';
  if (code === 'too_large') return 'Amount exceeds the maximum of 500.00 GGT (demo) per transfer.';
  if (code === 'insufficient_funds') return 'Amount exceeds your balance of ' + formatMinorUnits(balanceMinor) + ' GGT (demo).';
  if (code === 'zero' || code === 'negative') return 'Enter an amount greater than 0.00 GGT (demo).';
  return 'Enter a demo amount such as 25.00.';
}

function applySendingState(button) {
  if (!button) return;
  button.textContent = SENDING_LABEL;
  button.setAttribute('aria-disabled', 'true');
  button.setAttribute('aria-busy', 'true');
}

function dismissToast(toast, scheduler, ms) {
  const win = scheduler || (typeof window !== 'undefined' ? window : null);
  if (!toast || !win || typeof win.setTimeout !== 'function') return null;
  return win.setTimeout(() => {
    if (typeof toast.remove === 'function') toast.remove();
    else if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, ms == null ? TOAST_DISMISS_MS : ms);
}

function initWallet(doc) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.getElementById !== 'function') return;
  const form = root.getElementById('transfer');
  const toast = root.querySelector ? root.querySelector('.wallet-page .toast') : null;
  if (toast) {
    dismissToast(toast);
    const close = toast.querySelector('.t-x');
    if (close) close.addEventListener('click', () => toast.remove());
  }
  const copyButton = root.getElementById('copy-wallet');
  if (copyButton) {
    copyButton.addEventListener('click', () => {
      const id = copyButton.getAttribute('data-wallet-id') || '';
      const live = root.getElementById('copy-live');
      const done = () => {
        copyButton.textContent = 'Copied';
        if (live) live.textContent = 'Copied demo wallet id ' + id;
      };
      const clipboard = typeof navigator !== 'undefined' && navigator.clipboard;
      if (clipboard && clipboard.writeText) clipboard.writeText(id).then(done).catch(done);
      else done();
    });
  }
  if (!form) return;
  const recipient = root.getElementById('recipient');
  const amount = root.getElementById('amount');
  const message = root.getElementById('message');
  const recipientHint = root.getElementById('recipient-hint');
  const amountHint = root.getElementById('amount-hint');
  const messageCount = root.getElementById('message-count');
  const summarySend = root.getElementById('summary-send');
  const summaryAfter = root.getElementById('summary-after');
  const sendButton = root.getElementById('send-btn');
  const loading = root.getElementById('wallet-loading');
  const recipientWrap = recipient && recipient.closest ? recipient.closest('.inp') : null;
  const amountWrap = amount && amount.closest ? amount.closest('.inp') : null;
  const balanceMinor = Number(form.getAttribute('data-balance-minor') || '0');
  const maxMinor = Number(form.getAttribute('data-max-minor') || String(MAX_TRANSFER_MINOR));
  let recipientState = { found: false, self: false, username: '', checked: false };
  if (recipientWrap && recipientWrap.classList.contains('is-valid') && recipient) {
    recipientState = {
      found: true,
      self: false,
      username: recipient.value.trim().replace(/^@+/, ''),
      checked: true,
    };
  } else if (recipient && recipient.getAttribute('aria-invalid') === 'true') {
    const self = !!(recipientHint && /yourself/.test(recipientHint.textContent || ''));
    recipientState = {
      found: false,
      self,
      username: recipient.value.trim().replace(/^@+/, ''),
      checked: true,
    };
  }
  let lookupTimer = null;

  function setHint(node, text, kind) {
    if (!node) return;
    node.textContent = text;
    node.classList.remove('err', 'ok');
    if (kind) node.classList.add(kind);
  }

  function paintAmount() {
    const result = classifyAmount(amount ? amount.value : '', balanceMinor, maxMinor);
    if (!amount || !amount.value.trim()) {
      if (amountWrap) amountWrap.classList.remove('is-error');
      if (amount) amount.removeAttribute('aria-invalid');
      if (amountHint && !amountHint.dataset.serverError) {
        amountHint.classList.remove('err');
        amountHint.textContent = 'Available: ' + formatMinorUnits(balanceMinor) + ' GGT (demo) · min 0.01 GGT (demo) · max ' + formatMinorUnits(maxMinor) + ' GGT (demo) per transfer';
      }
      if (summarySend) summarySend.textContent = '\u2014';
      if (summaryAfter) summaryAfter.textContent = '\u2014';
      return result;
    }
    if (!result.ok) {
      if (amountWrap) amountWrap.classList.add('is-error');
      if (amount) amount.setAttribute('aria-invalid', 'true');
      setHint(amountHint, '\u26A0 ' + amountMessage(result.code, balanceMinor), 'err');
      if (summarySend) summarySend.textContent = '\u2014';
      if (summaryAfter) summaryAfter.textContent = '\u2014';
      return result;
    }
    if (amountWrap) amountWrap.classList.remove('is-error');
    if (amount) amount.removeAttribute('aria-invalid');
    if (amountHint) amountHint.classList.remove('err');
    if (summarySend) summarySend.textContent = formatMinorUnits(result.minor) + ' GGT (demo)';
    if (summaryAfter) summaryAfter.textContent = formatMinorUnits(balanceMinor - result.minor) + ' GGT (demo)';
    if (sendButton) sendButton.textContent = 'Send ' + formatMinorUnits(result.minor) + ' GGT (demo)';
    return result;
  }

  function refreshSubmit(result) {
    const memoOk = !message || message.value.length <= 140;
    const blocked = recipientState.checked && (!recipientState.found || recipientState.self);
    const ready = !!(result && result.ok && !blocked && memoOk && recipient && recipient.value.trim());
    if (!sendButton) return;
    sendButton.disabled = !ready;
    if (!result || !result.ok) sendButton.textContent = 'Send GGT (demo)';
  }

  function applyRecipient(data) {
    recipientState = {
      found: !!(data && data.found),
      self: !!(data && data.self),
      username: data && data.username ? data.username : '',
      checked: true,
    };
    if (!recipientWrap) return;
    recipientWrap.classList.remove('is-valid', 'is-error');
    if (recipientState.found && !recipientState.self) {
      recipientWrap.classList.add('is-valid');
      if (recipient) recipient.removeAttribute('aria-invalid');
      setHint(recipientHint, 'Gitgram user found: @' + recipientState.username, 'ok');
    } else if (recipientState.self) {
      recipientWrap.classList.add('is-error');
      if (recipient) recipient.setAttribute('aria-invalid', 'true');
      setHint(recipientHint, "You can't send demo tokens to yourself.", 'err');
    } else if (recipient && recipient.value.trim()) {
      recipientWrap.classList.add('is-error');
      if (recipient) recipient.setAttribute('aria-invalid', 'true');
      const name = recipient.value.trim().replace(/^@+/, '');
      setHint(recipientHint, 'No Gitgram user named @' + name, 'err');
    } else {
      if (recipient) recipient.removeAttribute('aria-invalid');
      setHint(recipientHint, 'Gitgram username of the recipient.', null);
    }
  }

  if (recipient) {
    recipient.addEventListener('input', () => {
      clearTimeout(lookupTimer);
      const name = recipient.value.trim().replace(/^@+/, '');
      if (!name) {
        recipientState = { found: false, self: false, username: '', checked: false };
        applyRecipient(null);
        refreshSubmit(paintAmount());
        return;
      }
      setHint(recipientHint, 'Checking Gitgram user\u2026', null);
      if (recipientWrap) recipientWrap.setAttribute('aria-busy', 'true');
      lookupTimer = setTimeout(async () => {
        try {
          const response = await fetch('/api/wallet/lookup?username=' + encodeURIComponent(name));
          const data = await response.json();
          if (recipient.value.trim().replace(/^@+/, '') !== name) return;
          applyRecipient(data);
        } catch {
          setHint(recipientHint, 'Could not check that username. The server will check it when you send.', null);
        } finally {
          if (recipientWrap) recipientWrap.removeAttribute('aria-busy');
          refreshSubmit(paintAmount());
        }
      }, 200);
    });
  }
  if (amount) {
    amount.addEventListener('input', () => {
      if (amountHint) delete amountHint.dataset.serverError;
      refreshSubmit(paintAmount());
    });
  }
  if (message && messageCount) {
    message.addEventListener('input', () => {
      messageCount.textContent = message.value.length + '/140';
      refreshSubmit(paintAmount());
    });
  }
  form.addEventListener('submit', (event) => {
    const result = paintAmount();
    const blocked = recipientState.checked && (!recipientState.found || recipientState.self);
    if (!result.ok || blocked || (recipient && !recipient.value.trim())) {
      event.preventDefault();
      refreshSubmit(result);
      return;
    }
    applySendingState(sendButton);
    if (loading) loading.hidden = false;
    form.setAttribute('aria-busy', 'true');
    setTimeout(() => {
      if (sendButton) sendButton.disabled = true;
    }, 0);
  });
  refreshSubmit(paintAmount());
}

if (typeof document !== 'undefined') initWallet(document);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TOAST_DISMISS_MS,
    SENDING_LABEL,
    formatMinorUnits,
    classifyAmount,
    amountMessage,
    applySendingState,
    dismissToast,
    initWallet,
  };
}

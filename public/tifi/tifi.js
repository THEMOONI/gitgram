(function () {
  var root = document.querySelector('.tifi');
  if (!root) return;
  var clock = document.querySelector('[data-clock]');
  function tick() {
    if (!clock) return;
    clock.textContent = 'live · ' + new Date().toISOString().slice(11, 19) + ' UTC';
  }
  tick();
  window.setInterval(tick, 1000);

  var boxes = document.querySelectorAll('[data-risk] input');
  var hint = document.getElementById('h1');
  var accept = document.getElementById('accept');
  function syncRisk() {
    if (!boxes.length) return;
    var n = 0;
    boxes.forEach(function (box) { if (box.checked) n += 1; });
    if (hint) hint.textContent = n + ' av 3 ikryssade. Kryssa i alla för att fortsätta.';
    if (accept) accept.disabled = n !== 3;
  }
  boxes.forEach(function (box) { box.addEventListener('change', syncRisk); });
  syncRisk();

  var pw1 = document.getElementById('pw1');
  var pw2 = document.getElementById('pw2');
  var pwNext = document.getElementById('pw-next');
  function syncPw() {
    if (!pw1 || !pw2) return;
    var n = pw1.value.length;
    var bars = document.querySelectorAll('#pw-meter i');
    var lit = n >= 16 ? 4 : n >= 12 ? 3 : n >= 8 ? 2 : n > 0 ? 1 : 0;
    bars.forEach(function (bar, index) { bar.classList.toggle('on', index < lit); });
    var h1 = document.getElementById('pw1h');
    var h2 = document.getElementById('pw2h');
    if (h1) {
      h1.className = 'tifi-hint' + (n >= 12 ? ' tifi-hint--ok' : n ? ' tifi-hint--error' : '');
      h1.textContent = n >= 12 ? 'Starkt nog · ' + n + ' tecken' : 'Minst 12 tecken.';
    }
    pw1.setAttribute('aria-invalid', n > 0 && n < 12 ? 'true' : 'false');
    var match = pw2.value.length > 0 && pw1.value === pw2.value;
    if (h2) {
      h2.className = 'tifi-hint' + (match ? ' tifi-hint--ok' : pw2.value ? ' tifi-hint--error' : '');
      h2.textContent = match ? 'Lösenorden matchar' : pw2.value ? 'Lösenorden matchar inte.' : '';
    }
    if (pwNext) pwNext.disabled = !(n >= 12 && match);
  }
  if (pw1 && pw2) {
    pw1.addEventListener('input', syncPw);
    pw2.addEventListener('input', syncPw);
    syncPw();
  }

  var dialog = document.getElementById('tifi-consent');
  var openConsent = document.getElementById('open-consent');
  if (dialog && openConsent && dialog.showModal) {
    openConsent.addEventListener('click', function () { dialog.showModal(); });
    dialog.addEventListener('cancel', function () {
      var reject = dialog.querySelector('[value="reject"]');
      if (reject) reject.click();
    });
  }

  window.setInterval(function () {
    fetch('/tifi/api/state', { headers: { accept: 'application/json' } })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) {
        if (!body || !body.board) return;
        var totals = body.board.totals;
        var map = {
          pnl: totals.pnl,
          fees: totals.fees,
          funding: totals.funding,
          model: totals.modelCost,
          decisions: String(totals.decisions),
        };
        Object.keys(map).forEach(function (key) {
          var node = document.querySelector('[data-total="' + key + '"]');
          if (node) node.textContent = map[key];
        });
      })
      .catch(function () {});
  }, 5000);
})();

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return '';
  if (/[\u0000-\u001F\s]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

function panelClass(panel) {
  if (panel === 'legal' || panel === 'demo' || panel === 'human' || panel === 'system' || panel === 'standard') {
    return panel;
  }
  return 'standard';
}

function severityClass(value) {
  if (value === 'hög') return 'high';
  if (value === 'medel') return 'medium';
  if (value === 'låg') return 'low';
  return 'unknown';
}

function riskClass(value) {
  if (value === 'LÅG') return 'lag';
  if (value === 'MEDEL') return 'medel';
  if (value === 'HÖG') return 'hog';
  if (value === 'EXTREM') return 'extrem';
  return 'unknown';
}

function micSupported(nav) {
  return Boolean(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined');
}

function mentionQuery(value, cursor) {
  const text = String(value || '');
  const upto = text.slice(0, cursor == null ? text.length : cursor);
  const match = upto.match(/(^|\s)@([a-z0-9-]*)$/i);
  return match ? match[2] : null;
}

function visibleMentions(agents, query) {
  if (query == null) return [];
  const needle = String(query).toLowerCase();
  return (agents || []).filter((agent) => {
    const slug = String(agent.slug || '').toLowerCase();
    const name = String(agent.name || '').toLowerCase();
    return slug.startsWith(needle) || name.startsWith(needle);
  });
}

function pushToTalkBlocked(options) {
  if (!options.voiceAvailable || !options.micSupported) return true;
  return !options.acknowledged;
}

function voiceNotes(options) {
  const notes = [];
  if (!options.voiceAvailable && options.voiceNotice) notes.push(options.voiceNotice);
  if (!options.micSupported && options.micNotice) notes.push(options.micNotice);
  return notes;
}

function renderMessageHtml(message, options = {}) {
  const panel = panelClass(message.panel);
  const tags = (message.legalTags || []).map((tag) => `<li>${escapeHtml(tag)}</li>`).join('');
  const risks = (message.risks || []).map((risk) => `<li>${escapeHtml(risk)}</li>`).join('');
  const badges = (message.badges || []).map((badge) => `<p class="team-lawyer-badge">${escapeHtml(badge.label)}</p>`).join('');
  const files = (message.documents || []).map((doc) => (
    `<li><span class="team-file-name">${escapeHtml(doc.name)}</span> <span class="team-preview">${escapeHtml(doc.preview || '')}</span></li>`
  )).join('');
  const disclaimer = message.disclaimer
    ? (panel === 'demo'
      ? `<p class="team-demo-banner">${escapeHtml(message.disclaimer)}</p>`
      : panel === 'legal'
        ? `<p class="team-disclaimer">${escapeHtml(message.disclaimer)}</p>`
        : '')
    : '';
  const speak = options.voiceAvailable && message.authorType === 'agent'
    ? `<button type="button" class="tbtn tbtn-ghost" data-speak="/api/team/messages/${Number(message.id)}/speak" data-agent-name="${escapeHtml(message.authorName)}">Play AI speech</button>`
    : '';
  const initial = escapeHtml(String(message.authorName || '?').charAt(0).toUpperCase());
  const agentMark = message.authorType === 'agent'
    ? `<span class="ai-avatar" aria-label="${escapeHtml(message.authorName)}, AI-agent"><span class="ai-avatar__fallback" aria-hidden="true">${initial}</span><span class="ai-avatar__mark" aria-hidden="true">AI</span><span class="ai-sr-only">AI-agent</span></span><span class="ai-badge" role="status" aria-label="Det här är en AI-agent" title="Det här är en AI-agent">AI-agent</span>`
    : '';
  return `<article class="team-msg is-${panel}" id="message-${Number(message.id)}">
    <header class="team-msg-head">
      ${agentMark}
      <span class="team-author">${escapeHtml(message.authorName)}</span>
      <time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(message.displayTime || '')}</time>
    </header>
    ${panel === 'demo' ? disclaimer : ''}
    ${risks ? `<ul class="team-risks">${risks}</ul>` : ''}
    <p class="team-body">${escapeHtml(message.body)}</p>
    ${tags ? `<ul class="team-tags">${tags}</ul>` : ''}
    ${badges}
    ${files ? `<ul class="team-files">${files}</ul>` : ''}
    ${panel === 'legal' ? disclaimer : ''}
    ${speak}
  </article>`;
}

function renderTradingAlertHtml(alert, options = {}) {
  const reasons = (alert.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
  const href = safeDexScreenerUrl(alert.safeUrl || alert.link, alert.mint);
  const link = href
    ? `<p><a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">DEX Screener</a></p>`
    : '';
  const acks = (alert.acknowledgements || []).map((ack) => (
    `<li>Acknowledged by ${escapeHtml(ack.username)} at <time datetime="${escapeHtml(ack.createdAt)}">${escapeHtml(ack.displayTime || '')}</time></li>`
  )).join('');
  const csrf = escapeHtml(options.csrfToken || '');
  const symbol = alert.symbol ? `<span class="team-author">${escapeHtml(alert.symbol)}</span>` : '';
  const name = alert.name ? `<span>${escapeHtml(alert.name)}</span>` : '';
  return `<article class="team-trading-card" id="trading-alert-${Number(alert.id)}" data-external-id="${escapeHtml(alert.externalId || '')}" data-mint="${escapeHtml(alert.mint || '')}" data-stage="${escapeHtml(alert.stage || '')}" data-label="${escapeHtml(alert.label || '')}">
    <p class="team-demo-banner">${escapeHtml(alert.demoLabel || '')}</p>
    <header class="team-msg-head">
      <span class="team-risk-badge ${riskClass(alert.label)}">${escapeHtml(alert.label || '')}</span>
      <span class="team-score">Risk score ${Number(alert.score)}</span>
      ${symbol}
      ${name}
      <time datetime="${escapeHtml(alert.createdAt || '')}">${escapeHtml(alert.displayTime || '')}</time>
    </header>
    <p class="team-body">${escapeHtml(alert.summary || '')}</p>
    ${reasons ? `<ul class="team-risks">${reasons}</ul>` : ''}
    <p class="team-source">Source <span>${escapeHtml(alert.source || '')}</span></p>
    ${link}
    <p class="team-demo-banner">${escapeHtml(alert.disclaimer || '')}</p>
    <ul class="team-acks">${acks}</ul>
    <form method="post" action="/api/team/trading-alerts/${Number(alert.id)}/ack">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit" class="tbtn tbtn-secondary">Acknowledge</button>
    </form>
  </article>`;
}

function safeDexScreenerUrl(value, mint) {
  const href = safeHttpUrl(value);
  if (!href || typeof mint !== 'string' || !mint) return '';
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    if (host !== 'dexscreener.com' && host !== 'www.dexscreener.com') return '';
    if (url.username || url.password || url.search || url.hash) return '';
    if (url.pathname !== `/solana/${mint}`) return '';
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '';
  }
}

function renderFlagHtml(flag, options = {}) {
  const href = safeHttpUrl(flag.safeUrl || flag.sourceUrl);
  const projects = (flag.affectedProjects || []).map((project) => `<span class="team-chip">${escapeHtml(project)}</span>`).join('') || '<span>Inga</span>';
  const agents = (flag.affectedAgents || []).map((name) => `<span class="team-chip">${escapeHtml(name)}</span>`).join('') || '<span>Inga</span>';
  const acks = (flag.acknowledgements || []).map((ack) => (
    `<li>Acknowledged by ${escapeHtml(ack.username)} at <time datetime="${escapeHtml(ack.createdAt)}">${escapeHtml(ack.displayTime || '')}</time></li>`
  )).join('');
  const link = href ? `<p><a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${escapeHtml(flag.sourceUrl)}</a></p>` : '';
  const csrf = escapeHtml(options.csrfToken || '');
  return `<article class="team-flag sev-${severityClass(flag.severity)}" id="flag-${Number(flag.id)}">
    <p class="team-flag-kicker">${escapeHtml(flag.kindLabel || '')}</p>
    <h3>${escapeHtml(flag.title)}</h3>
    <p class="team-sev">Severity <strong>${escapeHtml(flag.severity)}</strong></p>
    <p>${escapeHtml(flag.summary)}</p>
    <p>Projects ${projects}</p>
    <p>Agents ${agents}</p>
    <p>Recommended action: ${escapeHtml(flag.recommendedAction)}</p>
    <p class="team-lawyer-badge">${escapeHtml(flag.needsLawyerText || '')}</p>
    ${link}
    <ul class="team-acks">${acks}</ul>
    <form method="post" action="/api/team/flags/${Number(flag.id)}/ack">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit" class="tbtn tbtn-secondary">Acknowledge</button>
    </form>
  </article>`;
}

function initTeam(doc) {
  const rootDoc = doc || (typeof document !== 'undefined' ? document : null);
  if (!rootDoc || !rootDoc.getElementById) return;
  const root = rootDoc.getElementById('team-app');
  const dataNode = rootDoc.getElementById('team-data');
  if (!root || !dataNode) return;
  const bootstrap = JSON.parse(dataNode.textContent);
  const log = rootDoc.getElementById('team-log');
  const seen = new Set();
  rootDoc.querySelectorAll('.team-msg, .team-flag').forEach((node) => seen.add(node.id));

  function remember(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    const empty = rootDoc.getElementById('team-empty');
    if (empty) empty.remove();
    return true;
  }

  function alertPassesFilter(alert) {
    const filters = bootstrap.filters || {};
    if (filters.risk && alert.label !== filters.risk) return false;
    const acked = (alert.acknowledgements || []).length > 0;
    if (filters.ack === 'open' && acked) return false;
    if (filters.ack === 'done' && !acked) return false;
    return true;
  }

  function playNotice(sound) {
    if (!sound || !rootDoc.defaultView) return;
    const Ctx = rootDoc.defaultView.AudioContext || rootDoc.defaultView.webkitAudioContext;
    if (!Ctx) return;
    try {
      const audio = new Ctx();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 660;
      gain.gain.value = 0.02;
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.12);
      osc.onended = () => audio.close();
    } catch {
      /* autoplay or audio devices can be unavailable */
    }
  }

  function upsertTradingAlert(alert) {
    if (!log || !alert || !alertPassesFilter(alert)) return;
    const html = renderTradingAlertHtml(alert, { csrfToken: bootstrap.csrfToken });
    const existing = rootDoc.getElementById(`trading-alert-${Number(alert.id)}`);
    if (existing) {
      existing.outerHTML = html;
      return;
    }
    if (alert.stage === 'uppföljning') {
      rootDoc.querySelectorAll('[data-mint]').forEach((node) => {
        if (node.getAttribute('data-mint') === alert.mint) node.remove();
      });
    }
    rootDoc.querySelectorAll('[data-external-id]').forEach((node) => {
      if (node.getAttribute('data-external-id') === alert.externalId) node.remove();
    });
    if (!remember(`trading-alert-${alert.id}`)) return;
    log.insertAdjacentHTML('beforeend', html);
    log.scrollTop = log.scrollHeight;
  }

  function showNotice(notice) {
    if (!log || !notice) return;
    if (notice.digest) {
      const text = `${notice.text || ''} ${bootstrap.tradingNoticeDisclaimer || ''}`.trim();
      const html = `<p class="team-trading-notice${notice.sound ? '' : ' is-quiet'}" id="trading-digest" data-sound="${notice.sound ? '1' : '0'}">${escapeHtml(text)}</p>`;
      const current = rootDoc.getElementById('trading-digest');
      if (current) current.outerHTML = html;
      else log.insertAdjacentHTML('afterbegin', html);
      playNotice(notice.sound);
      return;
    }
    const html = `<p class="team-trading-notice${notice.sound ? '' : ' is-quiet'}" data-sound="${notice.sound ? '1' : '0'}">${escapeHtml(notice.text || '')}</p>`;
    log.insertAdjacentHTML('afterbegin', html);
    playNotice(notice.sound);
  }

  function showWatcherStatus(offline, text) {
    let node = rootDoc.getElementById('trading-watcher-status');
    if (!offline) {
      if (node) node.remove();
      return;
    }
    if (!node) {
      const head = rootDoc.getElementById('trading-channel-disclaimer');
      if (!head) return;
      head.insertAdjacentHTML('beforeend', `<p class="team-watcher-status" id="trading-watcher-status"></p>`);
      node = rootDoc.getElementById('trading-watcher-status');
    }
    node.textContent = text || bootstrap.tradingWatcherOffline || '';
  }

  function appendItem(item) {
    if (!item) return;
    if (item.kind === 'trading_alert') {
      upsertTradingAlert(item);
      return;
    }
    if (item.kind === 'flag' ? !remember(`flag-${item.id}`) : !remember(`message-${item.id}`)) return;
    const html = item.kind === 'flag'
      ? renderFlagHtml(item, { csrfToken: bootstrap.csrfToken })
      : renderMessageHtml(item, { voiceAvailable: bootstrap.voiceAvailable });
    log.insertAdjacentHTML('beforeend', html);
    log.scrollTop = log.scrollHeight;
    if (item.authorType === 'agent') {
      const live = rootDoc.getElementById('team-ai-live');
      if (live) live.textContent = `AI-agent ${item.authorName}. Det här är en AI-agent.`;
    }
  }

  rootDoc.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      root.dataset.panel = button.dataset.tab;
      rootDoc.querySelectorAll('[data-tab]').forEach((tab) => {
        const selected = tab === button;
        tab.classList.toggle('is-selected', selected);
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
    });
  });

  const storage = rootDoc.defaultView && rootDoc.defaultView.sessionStorage;
  const overlay = rootDoc.getElementById('ai-first-overlay');
  const persistent = rootDoc.getElementById('ai-persistent');
  const firstAck = rootDoc.getElementById('ai-first-ack');
  function focusable(dialog) {
    return [...dialog.querySelectorAll('a[href], button, input, textarea, select')].filter((el) => !el.disabled);
  }
  function trapDialog(dialog) {
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;
      const list = focusable(dialog);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && rootDoc.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && rootDoc.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    const list = focusable(dialog);
    if (list[0]) list[0].focus();
  }
  if (overlay && storage && storage.getItem('gitgram-ai-first') === '1') {
    overlay.hidden = true;
    if (persistent) persistent.hidden = false;
  } else if (overlay) {
    trapDialog(overlay);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) event.stopPropagation();
    });
  }
  if (firstAck) {
    firstAck.addEventListener('click', () => {
      if (storage) storage.setItem('gitgram-ai-first', '1');
      if (overlay) overlay.hidden = true;
      if (persistent) persistent.hidden = false;
    });
  }

  const status = rootDoc.getElementById('voice-status');
  const talk = rootDoc.getElementById('push-to-talk');
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const micOk = micSupported(nav);
  const notes = voiceNotes({
    voiceAvailable: bootstrap.voiceAvailable,
    micSupported: micOk,
    voiceNotice: status ? status.textContent.trim() : '',
    micNotice: bootstrap.micNotice,
  });
  if (!bootstrap.voiceAvailable && status && !status.textContent.trim()) notes.unshift('Text only. No speech API key is set, so voice stays off.');
  if (status) status.textContent = notes.filter(Boolean).join(' ');
  if (talk && (!bootstrap.voiceAvailable || !micOk)) talk.disabled = true;

  const messageBody = rootDoc.getElementById('message-body');
  const mentionList = rootDoc.getElementById('mention-list');
  const agents = rootDoc.querySelectorAll('#mention-list [data-slug]');
  function syncMentions() {
    if (!messageBody || !mentionList) return;
    const query = mentionQuery(messageBody.value, messageBody.selectionStart);
    let shown = 0;
    agents.forEach((item) => {
      const match = query != null && visibleMentions([{
        slug: item.dataset.slug,
        name: item.textContent || '',
      }], query).length > 0;
      item.hidden = !match;
      if (match) shown += 1;
    });
    mentionList.hidden = shown === 0;
  }
  if (messageBody) {
    messageBody.addEventListener('input', syncMentions);
    messageBody.addEventListener('click', syncMentions);
    messageBody.addEventListener('keyup', syncMentions);
  }
  if (mentionList) {
    mentionList.addEventListener('click', (event) => {
      const item = event.target.closest('[data-slug]');
      if (!item || !messageBody) return;
      const query = mentionQuery(messageBody.value, messageBody.selectionStart);
      if (query == null) return;
      const cursor = messageBody.selectionStart;
      const start = cursor - query.length;
      messageBody.value = `${messageBody.value.slice(0, start)}${item.dataset.slug} ${messageBody.value.slice(cursor)}`;
      mentionList.hidden = true;
      messageBody.focus();
    });
  }

  const form = rootDoc.getElementById('team-composer');
  const errorBox = rootDoc.getElementById('team-form-error');
  function showError(text) {
    if (!errorBox) return;
    errorBox.hidden = !text;
    errorBox.textContent = text || '';
  }

  async function sendPayload(payload) {
    const response = await fetch(`/api/team/rooms/${encodeURIComponent(bootstrap.room)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': bootstrap.csrfToken,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showError(data.message || 'That message could not be sent.');
      return null;
    }
    showError('');
    appendItem(data.message);
    return data.message;
  }

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = rootDoc.getElementById('message-body').value;
      const contractText = rootDoc.getElementById('contract-text').value;
      const legalTags = [...form.querySelectorAll('input[name="legalTags"]:checked')].map((input) => input.value);
      const fileInput = rootDoc.getElementById('contract-file');
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (file && file.size > bootstrap.maxUploadBytes) {
        showError('That file is over the 2 MB limit.');
        return;
      }
      let encoded = null;
      if (file) {
        encoded = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const text = String(reader.result || '');
            resolve(text.slice(text.indexOf(',') + 1));
          };
          reader.onerror = () => reject(new Error('read failed'));
          reader.readAsDataURL(file);
        });
      }
      const message = await sendPayload({
        body,
        legalTags,
        contractText,
        file: file ? { name: file.name, dataBase64: encoded } : undefined,
      });
      if (message) {
        rootDoc.getElementById('message-body').value = '';
        rootDoc.getElementById('contract-text').value = '';
        if (fileInput) fileInput.value = '';
      }
    });
  }

  rootDoc.querySelectorAll('.team-turn').forEach((button) => {
    button.addEventListener('click', () => {
      const typed = rootDoc.getElementById('message-body').value.trim();
      sendPayload({
        body: typed || 'Your turn.',
        addressedAgentId: Number(button.dataset.agentId),
        legalTags: [...(form ? form.querySelectorAll('input[name="legalTags"]:checked') : [])].map((input) => input.value),
      });
    });
  });

  const voiceDialog = rootDoc.getElementById('ai-voice');
  const voiceBanner = rootDoc.getElementById('ai-voice-banner');
  const voiceLive = rootDoc.getElementById('ai-voice-live');
  const voiceStart = rootDoc.getElementById('ai-voice-start');
  const voiceCancel = rootDoc.getElementById('ai-voice-cancel');
  const voiceConsent = rootDoc.getElementById('ai-voice-consent');
  const orgName = root.dataset.aiOrg || 'Scavvers Labs';
  let pendingSpeak = '';
  function setVoiceName(name) {
    rootDoc.querySelectorAll('.ai-voice-name').forEach((node) => {
      node.textContent = name;
    });
    const script = rootDoc.getElementById('ai-voice-script');
    if (script) script.textContent = `Du pratar med en AI-agent. Rösten tillhör ${name}, som handlar för ${orgName}.`;
    const bannerText = rootDoc.getElementById('ai-voice-banner-text');
    if (bannerText) bannerText.textContent = `Du pratar med ${name} (AI-agent)`;
    const liveText = rootDoc.querySelector('.ai-voice-live__text');
    if (liveText) liveText.textContent = `Samtal med AI-agent · ${name}`;
  }
  function showCall(active) {
    if (voiceBanner) voiceBanner.hidden = !active;
    if (voiceLive) voiceLive.hidden = !active;
  }
  function openVoice(name) {
    setVoiceName(name);
    if (!voiceDialog) return;
    voiceDialog.hidden = false;
    if (voiceStart) voiceStart.focus();
  }
  function closeVoice() {
    pendingSpeak = '';
    if (voiceDialog) voiceDialog.hidden = true;
  }
  if (voiceCancel) voiceCancel.addEventListener('click', closeVoice);
  if (voiceConsent) {
    voiceConsent.addEventListener('click', () => {
      const ackBox = rootDoc.getElementById('voice-ack');
      if (ackBox) ackBox.focus();
    });
  }

  async function playSpeech(url) {
    const response = await fetch(url);
    if (!response.ok) {
      showError('Speech playback is unavailable.');
      showCall(false);
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    audio.onended = () => {
      URL.revokeObjectURL(objectUrl);
      showCall(false);
    };
    showCall(true);
    await audio.play();
  }

  if (log) {
    log.addEventListener('click', (event) => {
      const button = event.target.closest('[data-speak]');
      if (!button) return;
      pendingSpeak = button.dataset.speak;
      openVoice(button.dataset.agentName || root.dataset.aiNames || 'AI-agent');
    });
  }

  if (talk && bootstrap.voiceAvailable && micOk) {
    let active = null;
    const ack = rootDoc.getElementById('voice-ack');
    if (ack && storage && storage.getItem('gitgram-voice-ack') === '1') ack.checked = true;
    if (ack) {
      ack.addEventListener('change', () => {
        if (storage) storage.setItem('gitgram-voice-ack', ack.checked ? '1' : '0');
      });
    }
    function openRoomVoice(event) {
      event.preventDefault();
      pendingSpeak = '';
      openVoice(root.dataset.aiNames || 'AI-agent');
    }
    async function start(event) {
      event.preventDefault();
      if (pendingSpeak) {
        const url = pendingSpeak;
        pendingSpeak = '';
        if (voiceDialog) voiceDialog.hidden = true;
        await playSpeech(url);
        return;
      }
      if (pushToTalkBlocked({
        voiceAvailable: bootstrap.voiceAvailable,
        micSupported: micOk,
        acknowledged: Boolean(ack && ack.checked),
      })) {
        if (ack) ack.focus();
        if (status) status.textContent = bootstrap.sendsAudioToCloud ? bootstrap.voiceCloudNotice : bootstrap.voiceLocalNotice;
        return;
      }
      if (active) return;
      try {
        const stream = await nav.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.addEventListener('dataavailable', (chunk) => {
          if (chunk.data && chunk.data.size) chunks.push(chunk.data);
        });
        const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
        recorder.start();
        if (voiceDialog) voiceDialog.hidden = true;
        showCall(true);
        talk.dataset.recording = '1';
        talk.setAttribute('aria-pressed', 'true');
        active = { stream, recorder, chunks, stopped };
        rootDoc.addEventListener('pointerup', stop);
        rootDoc.addEventListener('pointercancel', stop);
      } catch {
        talk.disabled = true;
        if (status) status.textContent = bootstrap.micNotice;
      }
    }
    async function stop() {
      rootDoc.removeEventListener('pointerup', stop);
      rootDoc.removeEventListener('pointercancel', stop);
      if (!active) return;
      const current = active;
      active = null;
      talk.dataset.recording = '0';
      talk.setAttribute('aria-pressed', 'false');
      showCall(false);
      if (current.recorder.state !== 'inactive') current.recorder.stop();
      await current.stopped;
      current.stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(current.chunks, { type: current.recorder.mimeType || 'audio/webm' });
      const response = await fetch(`/api/team/rooms/${encodeURIComponent(bootstrap.room)}/stt`, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm',
          'x-csrf-token': bootstrap.csrfToken,
        },
        body: blob,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(data.message || 'Voice could not be transcribed.');
        return;
      }
      appendItem(data.message);
    }
    talk.addEventListener('click', openRoomVoice);
    if (voiceStart) {
      voiceStart.addEventListener('pointerdown', start);
      voiceStart.addEventListener('pointerup', stop);
      voiceStart.addEventListener('pointercancel', stop);
      voiceStart.addEventListener('keydown', (event) => {
        if (event.key === ' ' || event.key === 'Enter') start(event);
      });
      voiceStart.addEventListener('keyup', (event) => {
        if (event.key === ' ' || event.key === 'Enter') stop();
      });
    }
  } else if (voiceStart) {
    voiceStart.addEventListener('click', async () => {
      if (!pendingSpeak) return;
      const url = pendingSpeak;
      pendingSpeak = '';
      if (voiceDialog) voiceDialog.hidden = true;
      await playSpeech(url);
    });
  }

  const proto = rootDoc.location && rootDoc.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (rootDoc.location && typeof WebSocket !== 'undefined') {
    const socket = new WebSocket(`${proto}//${rootDoc.location.host}/team/ws`);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', room: bootstrap.room }));
    });
    socket.addEventListener('message', (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.room && payload.room !== bootstrap.room) return;
      if (payload.type === 'message') appendItem(payload.message);
      if (payload.type === 'flag') appendItem(payload.flag);
      if (payload.type === 'trading_alert') upsertTradingAlert(payload.alert);
      if (payload.type === 'trading_notice') showNotice(payload.notice);
      if (payload.type === 'trading_status') showWatcherStatus(payload.offline, payload.text);
    });
  }
}

if (typeof document !== 'undefined') initTeam(document);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtml,
    safeHttpUrl,
    renderMessageHtml,
    renderFlagHtml,
    renderTradingAlertHtml,
    safeDexScreenerUrl,
    voiceNotes,
    micSupported,
    pushToTalkBlocked,
    mentionQuery,
    visibleMentions,
    initTeam,
  };
}

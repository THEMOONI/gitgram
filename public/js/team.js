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

function micSupported(nav) {
  return Boolean(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined');
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
    ? `<button type="button" class="tbtn tbtn-ghost" data-speak="/api/team/messages/${Number(message.id)}/speak">Play speech</button>`
    : '';
  const badge = escapeHtml(options.aiAgentBadge || 'AI-agent');
  const generatedLabel = escapeHtml(options.aiGeneratedLabel || 'AI-generated');
  const generated = message.aiGenerated || message.authorType === 'agent';
  return `<article class="team-msg is-${panel}" id="message-${Number(message.id)}">
    <header class="team-msg-head">
      <span class="team-author">${escapeHtml(message.authorName)}</span>
      ${message.authorType === 'agent' ? `<span class="team-ai-tag">${badge}</span>` : ''}
      ${generated ? `<span class="team-generated">${generatedLabel}</span>` : ''}
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

  function appendItem(item) {
    if (!item || (item.kind === 'flag' ? !remember(`flag-${item.id}`) : !remember(`message-${item.id}`))) return;
    const html = item.kind === 'flag'
      ? renderFlagHtml(item, { csrfToken: bootstrap.csrfToken })
      : renderMessageHtml(item, {
        voiceAvailable: bootstrap.voiceAvailable,
        aiAgentBadge: bootstrap.aiAgentBadge,
        aiGeneratedLabel: bootstrap.aiGeneratedLabel,
      });
    log.insertAdjacentHTML('beforeend', html);
    log.scrollTop = log.scrollHeight;
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

  if (log) {
    log.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-speak]');
      if (!button) return;
      const response = await fetch(button.dataset.speak);
      if (!response.ok) {
        showError('Speech playback is unavailable.');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    });
  }

  if (talk && bootstrap.voiceAvailable && micOk) {
    let active = null;
    const ack = rootDoc.getElementById('voice-ack');
    const storage = rootDoc.defaultView && rootDoc.defaultView.sessionStorage;
    if (ack && storage && storage.getItem('gitgram-voice-ack') === '1') ack.checked = true;
    if (ack) {
      ack.addEventListener('change', () => {
        if (storage) storage.setItem('gitgram-voice-ack', ack.checked ? '1' : '0');
      });
    }
    async function start(event) {
      event.preventDefault();
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
        talk.dataset.recording = '1';
        talk.setAttribute('aria-pressed', 'true');
        active = { stream, recorder, chunks, stopped };
      } catch {
        talk.disabled = true;
        if (status) status.textContent = bootstrap.micNotice;
      }
    }
    async function stop() {
      if (!active) return;
      const current = active;
      active = null;
      talk.dataset.recording = '0';
      talk.setAttribute('aria-pressed', 'false');
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
    talk.addEventListener('pointerdown', start);
    talk.addEventListener('pointerup', stop);
    talk.addEventListener('pointercancel', stop);
    talk.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') start(event);
    });
    talk.addEventListener('keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') stop();
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
    voiceNotes,
    micSupported,
    pushToTalkBlocked,
    initTeam,
  };
}

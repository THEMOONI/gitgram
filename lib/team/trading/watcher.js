const http = require('http');
const https = require('https');

function watcherOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  return url.origin;
}

function reconnectDelay(attempt, base = 2000, max = 60_000) {
  const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const wait = base * (2 ** step);
  if (!Number.isFinite(wait) || wait > max) return max;
  return wait;
}

function parseSseFrame(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: data.join('\n') };
}

function createWatcherClient(options) {
  const origin = watcherOrigin(options.origin || options.baseUrl);
  if (!origin) throw new Error('invalid watcher origin');
  const baseDelayMs = options.baseDelayMs || 2000;
  const maxDelayMs = options.maxDelayMs || 60_000;
  const statsIntervalMs = options.statsIntervalMs || 30_000;
  const lib = origin.startsWith('https:') ? https : http;
  const agent = new lib.Agent({ keepAlive: false });
  let stopped = false;
  let attempt = 0;
  let cursor = Number(options.sinceMs) || 0;
  let timer = null;
  let statsTimer = null;
  let current = null;
  let generation = 0;

  function noteCursor(ms) {
    if (Number.isFinite(ms) && ms > cursor) cursor = ms;
  }

  function handleAlert(payload) {
    let result;
    try {
      result = options.onAlert(payload);
    } catch {
      return 'drop';
    }
    if (result && result.error === 'rate_limit') return 'pause';
    if (result && Number.isFinite(result.tsMs)) noteCursor(result.tsMs);
    return 'ok';
  }

  function get(pathname, search) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, origin);
      if (search) {
        for (const [key, value] of Object.entries(search)) url.searchParams.set(key, String(value));
      }
      const req = lib.get(url, { agent, headers: { accept: 'application/json', connection: 'close' } }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 512 * 1024) {
            req.destroy(new Error('too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('status'));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  async function pollStats() {
    if (stopped || typeof options.onStats !== 'function') return;
    try {
      const body = await get('/api/stats');
      options.onStats(body);
    } catch {
      options.onStats(null);
    }
  }

  async function catchUp() {
    const search = { limit: 50 };
    if (cursor) search.since_ms = cursor;
    const body = await get('/api/team/summaries', search);
    const list = Array.isArray(body) ? body : (body && Array.isArray(body.summaries) ? body.summaries : []);
    for (const item of list) {
      if (handleAlert(item) === 'pause') return 'pause';
    }
    return 'ok';
  }

  function failStream() {
    if (stopped) return;
    const token = ++generation;
    if (current) {
      current.destroy();
      current = null;
    }
    if (typeof options.onStream === 'function') options.onStream(false);
    const wait = reconnectDelay(attempt, baseDelayMs, maxDelayMs);
    attempt += 1;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped || token !== generation) return;
      recover();
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function connect() {
    if (stopped) return;
    const token = generation;
    const url = new URL('/api/team/stream', origin);
    const req = lib.get(url, { agent, headers: { accept: 'text/event-stream' } }, (res) => {
      if (token !== generation || stopped) {
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        failStream();
        return;
      }
      attempt = 0;
      if (typeof options.onStream === 'function') options.onStream(true);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 256 * 1024) {
          buf = '';
          failStream();
          return;
        }
        buf = buf.replace(/\r\n/g, '\n');
        let split = buf.indexOf('\n\n');
        while (split >= 0) {
          const raw = buf.slice(0, split);
          buf = buf.slice(split + 2);
          const frame = parseSseFrame(raw);
          if (frame.event === 'alert' && frame.data) {
            let payload = null;
            try {
              payload = JSON.parse(frame.data);
            } catch {
              payload = null;
            }
            if (payload && handleAlert(payload) === 'pause') {
              failStream();
              return;
            }
          }
          split = buf.indexOf('\n\n');
        }
      });
      res.on('end', () => {
        if (!stopped && token === generation) failStream();
      });
      res.on('error', () => {
        if (!stopped && token === generation) failStream();
      });
    });
    req.setTimeout(0);
    req.on('error', () => {
      if (!stopped && token === generation) failStream();
    });
    current = req;
  }

  async function recover() {
    if (stopped) return;
    let result = 'ok';
    try {
      result = await catchUp();
    } catch {
      result = 'error';
    }
    if (stopped) return;
    if (result === 'pause') {
      failStream();
      return;
    }
    connect();
  }

  pollStats();
  statsTimer = setInterval(pollStats, statsIntervalMs);
  if (typeof statsTimer.unref === 'function') statsTimer.unref();
  recover();

  return {
    stop() {
      stopped = true;
      generation += 1;
      clearTimeout(timer);
      clearInterval(statsTimer);
      if (current) current.destroy();
      current = null;
      agent.destroy();
      if (typeof options.onStream === 'function') options.onStream(false);
    },
  };
}

module.exports = {
  watcherOrigin,
  reconnectDelay,
  parseSseFrame,
  createWatcherClient,
};

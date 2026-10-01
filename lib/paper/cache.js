const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TTL_MS = 24 * 60 * 60 * 1000;

function parseKey(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) return null;
  return Buffer.from(hex.trim(), 'hex');
}

function encrypt(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]);
}

function decrypt(key, blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(json);
}

function createPriceCache(options = {}) {
  const maxTtl = MAX_TTL_MS;
  const now = options.now || (() => Date.now());
  const key = options.key ? parseKey(options.key) : null;
  const dir = options.dir || null;
  const memory = new Map();
  if (dir && key) fs.mkdirSync(dir, { recursive: true });

  function fileFor(id) {
    const name = crypto.createHash('sha256').update(String(id)).digest('hex') + '.bin';
    return path.join(dir, name);
  }

  function readDisk(id) {
    if (!dir || !key) return null;
    const file = fileFor(id);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = decrypt(key, fs.readFileSync(file));
      if (!parsed || typeof parsed.exp !== 'number' || parsed.exp <= now() || parsed.exp - now() > maxTtl) {
        fs.rmSync(file, { force: true });
        return null;
      }
      return parsed.value;
    } catch (err) {
      fs.rmSync(file, { force: true });
      return null;
    }
  }

  return {
    maxTtlMs: maxTtl,
    disk: !!(dir && key),
    get(id) {
      const hit = memory.get(id);
      if (hit) {
        if (hit.exp <= now()) {
          memory.delete(id);
        } else {
          return hit.value;
        }
      }
      const stored = readDisk(id);
      if (stored == null) return null;
      return stored;
    },
    set(id, value, ttlMs) {
      const ttl = Math.min(Math.max(1, ttlMs || maxTtl), maxTtl);
      const exp = now() + ttl;
      memory.set(id, { exp, value });
      if (dir && key) {
        const payload = encrypt(key, { exp, value });
        fs.writeFileSync(fileFor(id), payload);
      }
    },
    purge() {
      memory.clear();
      if (dir && fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith('.bin')) fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    },
  };
}

module.exports = {
  MAX_TTL_MS,
  parseKey,
  createPriceCache,
};

const { safeHttpUrl } = require('./urls');

const SEVERITIES = new Set(['hög', 'medel', 'låg']);
const FLAG_KEYS = new Set([
  'title',
  'severity',
  'summary',
  'affectedProjects',
  'affectedAgents',
  'recommendedAction',
  'needsLawyer',
  'sourceUrl',
  'rooms',
]);

function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (!cleaned || cleaned.length > max) return '';
  return cleaned;
}

function stringList(value, { min, maxItems, maxLen }) {
  if (!Array.isArray(value) || value.length < min || value.length > maxItems) return null;
  const out = [];
  for (const item of value) {
    const cleaned = cleanLine(item, maxLen);
    if (!cleaned || !/^[\p{L}\p{N} ._/#'+-]{1,60}$/u.test(cleaned)) return null;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  if (out.length < min) return null;
  return out;
}

function validateFlagInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid' };
  const keys = Object.keys(body);
  if (keys.some((key) => !FLAG_KEYS.has(key)) || keys.length !== FLAG_KEYS.size) {
    return { ok: false, error: 'invalid' };
  }
  const title = cleanLine(body.title, 140);
  const summary = cleanLine(body.summary, 2000);
  const recommendedAction = cleanLine(body.recommendedAction, 500);
  if (!title || !summary || !recommendedAction) return { ok: false, error: 'invalid' };
  if (!SEVERITIES.has(body.severity)) return { ok: false, error: 'severity' };
  if (typeof body.needsLawyer !== 'boolean') return { ok: false, error: 'needs_lawyer' };
  const sourceUrl = safeHttpUrl(body.sourceUrl);
  if (!sourceUrl) return { ok: false, error: 'source_url' };
  const affectedProjects = stringList(body.affectedProjects, { min: 0, maxItems: 10, maxLen: 60 });
  const affectedAgents = stringList(body.affectedAgents, { min: 0, maxItems: 10, maxLen: 60 });
  const rooms = stringList(body.rooms, { min: 1, maxItems: 10, maxLen: 40 });
  if (!affectedProjects || !affectedAgents || !rooms) return { ok: false, error: 'invalid' };
  if (rooms.some((room) => !/^[a-z0-9][a-z0-9-]{0,38}$/.test(room))) return { ok: false, error: 'rooms' };
  return {
    ok: true,
    value: {
      title,
      severity: body.severity,
      summary,
      affectedProjects,
      affectedAgents,
      recommendedAction,
      needsLawyer: body.needsLawyer,
      sourceUrl,
      rooms,
    },
  };
}

module.exports = { validateFlagInput, SEVERITIES };

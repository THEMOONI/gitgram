const { loadTeamConfig } = require('./config');

/**
 * Legal copy and risk flags.
 * License notices, AI-transparency labels, and extra badges should be added
 * in config/legal-areas.json or config/agents.json and rendered from
 * message.disclaimer / message.badges. Keep new wording out of route code.
 */
function legalCopy(config = loadTeamConfig()) {
  return config.legal;
}

function normalizeTags(input, config = loadTeamConfig()) {
  if (input == null) return { ok: true, tags: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'tags' };
  if (input.length > config.legal.areas.length) return { ok: false, error: 'tags' };
  const allowed = new Set(config.areaLabels);
  const tags = [];
  for (const tag of input) {
    if (typeof tag !== 'string' || !allowed.has(tag)) return { ok: false, error: 'tags' };
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { ok: true, tags };
}

function assessLegal(text, config = loadTeamConfig()) {
  const blob = String(text || '');
  const matched = config.legal.highStakesPatterns.filter((pattern) => blob.toLowerCase().includes(pattern.toLowerCase()));
  return { needsLawyer: matched.length > 0, matched };
}

function suggestRisks(text, config = loadTeamConfig()) {
  const blob = String(text || '');
  const risks = [];
  for (const rule of config.legal.riskRules) {
    const re = new RegExp(rule.pattern, 'i');
    if (re.test(blob) && !risks.includes(rule.risk)) risks.push(rule.risk);
  }
  return risks.slice(0, 8);
}

function mergeRisks(...lists) {
  const risks = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const risk of list) {
      if (typeof risk !== 'string') continue;
      const trimmed = risk.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!trimmed || risks.includes(trimmed)) continue;
      risks.push(trimmed);
      if (risks.length >= 8) return risks;
    }
  }
  return risks;
}

function lawyerBadge(config = loadTeamConfig()) {
  return { kind: 'needs_lawyer', label: config.legal.needsLawyerBadge };
}

module.exports = {
  legalCopy,
  normalizeTags,
  assessLegal,
  suggestRisks,
  mergeRisks,
  lawyerBadge,
};

function extractMentions(body) {
  const found = new Set();
  if (typeof body !== 'string') return found;
  const re = /(^|[^\w])@([A-Za-z][A-Za-z0-9_-]{1,38})\b/g;
  let match;
  while ((match = re.exec(body))) found.add(match[2].toLowerCase());
  return found;
}

function isMentioned(agent, body) {
  const mentions = extractMentions(body);
  return mentions.has(String(agent.slug).toLowerCase()) || mentions.has(String(agent.name).toLowerCase());
}

function agentShouldRespond(agent, message, options = {}) {
  const maxHops = options.maxHops ?? 3;
  if (!agent || !message) return { respond: false, reason: 'missing' };
  if (message.author_type === 'system' || message.authorType === 'system') {
    return { respond: false, reason: 'system' };
  }
  const authorType = message.author_type || message.authorType;
  const authorAgentId = message.agent_id ?? message.agentId ?? null;
  if (authorType === 'agent' && Number(authorAgentId) === Number(agent.id)) {
    return { respond: false, reason: 'self' };
  }
  const body = message.body || '';
  const mentioned = isMentioned(agent, body);
  const addressed = message.addressed_agent_id ?? message.addressedAgentId ?? null;
  const givenTurn = authorType === 'user' && addressed != null && Number(addressed) === Number(agent.id);
  if (authorType === 'agent') {
    if (!mentioned) return { respond: false, reason: 'not_addressed' };
  } else if (!mentioned && !givenTurn) {
    return { respond: false, reason: 'not_addressed' };
  }
  const nextHop = Number(message.hop || 0) + 1;
  if (nextHop > maxHops) return { respond: false, reason: 'hop_limit' };
  return { respond: true, hop: nextHop, reason: mentioned ? 'mention' : 'turn' };
}

function canSpend(agent, usage, spend) {
  const tokens = Number(usage?.tokens || 0) + Number(spend?.tokens || 0);
  const cost = Number(usage?.cost_cents ?? usage?.costCents ?? 0) + Number(spend?.costCents ?? spend?.cost_cents ?? 0);
  if (tokens > Number(agent.daily_token_cap ?? agent.dailyTokenCap)) {
    return { ok: false, reason: 'token_cap' };
  }
  if (cost > Number(agent.daily_cost_cap_cents ?? agent.dailyCostCapCents)) {
    return { ok: false, reason: 'cost_cap' };
  }
  return { ok: true };
}

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

module.exports = { extractMentions, isMentioned, agentShouldRespond, canSpend, utcDay };

const crypto = require('crypto');
const { agentShouldRespond, canSpend } = require('./policy');
const { invokeAgent, resumeAgent } = require('./graph');

function messageShape(message) {
  return {
    author_type: message.authorType || message.author_type,
    agent_id: message.agentId ?? message.agent_id ?? null,
    body: message.body || '',
    hop: message.hop || 0,
    addressed_agent_id: message.addressedAgentId ?? message.addressed_agent_id ?? null,
  };
}

async function planAgentReply({ model, agent, context, maxHops }) {
  const decision = agentShouldRespond(agent, messageShape(context.message), { maxHops });
  if (!decision.respond) return { action: 'skip', reason: decision.reason };
  const estimate = model.estimate();
  const gate = canSpend(agent, {
    tokens: context.usage?.tokens || 0,
    cost_cents: context.usage?.costCents ?? context.usage?.cost_cents ?? 0,
  }, estimate);
  if (!gate.ok) return { action: 'skip', reason: 'daily_cap' };
  const tags = context.message.legalTags?.length
    ? context.message.legalTags
    : (agent.slug === 'juridik' ? ['General law'] : []);
  const threadId = crypto.randomUUID();
  const result = await invokeAgent(model, {
    slug: agent.slug,
    name: agent.name,
    model: agent.model || '',
    system_prompt: agent.systemPrompt || agent.system_prompt,
    allowed_tools: JSON.stringify(agent.allowedTools || JSON.parse(agent.allowed_tools || '[]')),
  }, {
    transcript: context.message.body,
    recent: context.recent || [],
    documents: context.documents || [],
    legalTags: tags,
    roster: context.roster || [],
  }, threadId);
  const usage = result.usage || estimate;
  if (result.__interrupt__?.length) {
    const value = result.__interrupt__[0].value || {};
    return {
      action: 'approval',
      threadId,
      parentId: context.message.id,
      hop: decision.hop,
      tool: value.tool || 'unknown',
      args: value.args || {},
      usage,
    };
  }
  const body = String(result.draft || '').trim();
  if (!body) return { action: 'skip', reason: 'empty' };
  return {
    action: 'reply',
    threadId,
    parentId: context.message.id,
    hop: decision.hop,
    body,
    usage,
    needsLawyer: Boolean(result.needsLawyer),
    risks: result.risks || [],
    legalTags: result.legalTags || tags,
  };
}

async function resumePlannedReply({ model, threadId, decision }) {
  const result = await resumeAgent(model, threadId, decision);
  return {
    body: String(result.draft || '').trim(),
    usage: { tokens: 1, costCents: 0 },
  };
}

module.exports = { planAgentReply, resumePlannedReply };

const { assessLegal, suggestRisks } = require('./legal');

function stripMentions(text) {
  return String(text || '').replace(/(^|[^\w])@([A-Za-z][A-Za-z0-9_-]{1,38})\b/g, '$1$2');
}

function createFakeModel() {
  return {
    name: 'fake',
    estimate() {
      return { tokens: 32, costCents: 0 };
    },
    async complete(input) {
      const transcript = String(input.transcript || '');
      const tool = transcript.match(/\[\[tool:([a-z0-9_-]+)\]\]/i);
      if (tool) {
        return {
          text: '',
          toolCall: { name: tool[1].toLowerCase(), args: {} },
          needsLawyer: false,
          risks: [],
          legalTags: input.legalTags || [],
          usage: { tokens: 32, costCents: 0 },
        };
      }
      const cleaned = stripMentions(transcript).replace(/\s+/g, ' ').trim().slice(0, 400);
      const agent = input.agent || {};
      if (agent.slug === 'juridik') {
        const docs = input.documents || [];
        const recent = input.recent || [];
        const blob = [
          transcript,
          ...docs.map((doc) => doc.text || ''),
          ...recent.map((item) => item.body || ''),
        ].join('\n');
        const prior = [...recent].reverse().find((item) => item.authorType === 'agent' && item.agentSlug !== 'juridik');
        let text = `I reviewed the last ${recent.length} messages and ${docs.length} attachment(s).`;
        if (prior) {
          text += ` Context includes: ${stripMentions(prior.body).replace(/\s+/g, ' ').trim().slice(0, 80)}`;
        }
        text += ' Risks, if any, are listed with this reply.';
        return {
          text,
          toolCall: null,
          needsLawyer: assessLegal(blob).needsLawyer,
          risks: suggestRisks(blob),
          legalTags: input.legalTags?.length ? input.legalTags : ['General law'],
          usage: { tokens: 32, costCents: 0 },
        };
      }
      if (agent.slug === 'trading') {
        return {
          text: `Paper discussion only. I can't place orders, touch a wallet, or promise a return. You asked: ${cleaned}`,
          toolCall: null,
          needsLawyer: false,
          risks: [],
          legalTags: [],
          usage: { tokens: 32, costCents: 0 },
        };
      }
      return {
        text: `${agent.name || 'Agent'}: noted — ${cleaned}`,
        toolCall: null,
        needsLawyer: false,
        risks: [],
        legalTags: [],
        usage: { tokens: 32, costCents: 0 },
      };
    },
  };
}

function createOpenAIModel(env = process.env) {
  const key = env.OPENAI_API_KEY;
  const modelName = env.LLM_MODEL || 'gpt-4o-mini';
  const estimateTokens = Number(env.LLM_ESTIMATE_TOKENS || 500);
  const centsPer1k = Number(env.LLM_CENTS_PER_1K_TOKENS || 0);
  return {
    name: 'openai',
    estimate() {
      return {
        tokens: estimateTokens,
        costCents: centsPer1k > 0 ? Math.ceil((estimateTokens / 1000) * centsPer1k) : 0,
      };
    },
    async complete(input) {
      const tools = (input.toolSpecs || []).map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      }));
      const recent = (input.recent || [])
        .map((item) => `${item.authorName}: ${item.body}`)
        .join('\n');
      const docs = (input.documents || [])
        .map((doc) => `Attachment ${doc.name}:\n${doc.text}`)
        .join('\n\n');
      const user = [
        input.legalTags?.length ? `Legal area tags: ${input.legalTags.join(', ')}` : '',
        recent ? `Recent room messages:\n${recent}` : '',
        docs ? `Attachments:\n${docs}` : '',
        `Latest message:\n${input.transcript}`,
      ].filter(Boolean).join('\n\n');
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.agent?.model || modelName,
          temperature: 0.2,
          max_tokens: 700,
          messages: [
            { role: 'system', content: input.systemPrompt },
            { role: 'user', content: user },
          ],
          tools: tools.length ? tools : undefined,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        throw new Error(`language model request failed (${response.status})`);
      }
      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      const call = message.tool_calls?.[0];
      const tokens = Number(data.usage?.total_tokens || estimateTokens);
      const costCents = centsPer1k > 0 ? Math.ceil((tokens / 1000) * centsPer1k) : 0;
      return {
        text: typeof message.content === 'string' ? message.content : '',
        toolCall: call ? { name: call.function?.name, args: safeJson(call.function?.arguments) } : null,
        needsLawyer: false,
        risks: [],
        legalTags: input.legalTags || [],
        usage: { tokens, costCents },
      };
    },
  };
}

function safeJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function createModel(env = process.env) {
  const provider = String(env.LLM_PROVIDER || '').toLowerCase();
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) return createFakeModel();
    return createOpenAIModel(env);
  }
  if (provider === 'fake' || provider === 'echo' || provider === 'none' || !env.OPENAI_API_KEY) {
    return createFakeModel();
  }
  return createOpenAIModel(env);
}

module.exports = { createFakeModel, createOpenAIModel, createModel, stripMentions };

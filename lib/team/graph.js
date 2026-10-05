const crypto = require('crypto');
const { StateGraph, Annotation, START, END, interrupt, Command, MemorySaver } = require('@langchain/langgraph');
const { READ_ONLY_TOOLS, toolSpecs } = require('./tools');

const compiledGraphs = new Map();

function parseTools(agent) {
  const raw = agent.allowedTools ?? agent.allowed_tools ?? [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function graphInput(agent, context) {
  return {
    agentSlug: agent.slug,
    agentName: agent.name,
    modelName: agent.model || '',
    systemPrompt: agent.system_prompt || agent.systemPrompt || '',
    allowedTools: parseTools(agent),
    transcript: context.transcript || '',
    recent: context.recent || [],
    documents: context.documents || [],
    legalTags: context.legalTags || [],
    roster: context.roster || [],
  };
}

function buildTeamGraph(model) {
  const State = Annotation.Root({
    agentSlug: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    agentName: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    modelName: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    systemPrompt: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    allowedTools: Annotation({ reducer: (_left, right) => right, default: () => [] }),
    transcript: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    recent: Annotation({ reducer: (_left, right) => right, default: () => [] }),
    documents: Annotation({ reducer: (_left, right) => right, default: () => [] }),
    legalTags: Annotation({ reducer: (_left, right) => right, default: () => [] }),
    roster: Annotation({ reducer: (_left, right) => right, default: () => [] }),
    draft: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    toolCall: Annotation({ reducer: (_left, right) => right, default: () => null }),
    needsLawyer: Annotation({ reducer: (_left, right) => right, default: () => false }),
    risks: Annotation({ reducer: (_left, right) => right, default: () => [] }),
    usage: Annotation({ reducer: (_left, right) => right, default: () => ({ tokens: 0, costCents: 0 }) }),
  });

  return new StateGraph(State)
    .addNode('think', async (state) => {
      const result = await model.complete({
        agent: { slug: state.agentSlug, name: state.agentName, model: state.modelName },
        systemPrompt: state.systemPrompt,
        transcript: state.transcript,
        recent: state.recent,
        documents: state.documents,
        legalTags: state.legalTags,
        roster: state.roster,
        toolSpecs: toolSpecs(state.allowedTools),
      });
      return {
        draft: result.text || '',
        toolCall: result.toolCall || null,
        needsLawyer: Boolean(result.needsLawyer),
        risks: result.risks || [],
        legalTags: result.legalTags || state.legalTags || [],
        usage: result.usage || { tokens: 0, costCents: 0 },
      };
    })
    .addNode('act', async (state) => {
      if (!state.toolCall) return {};
      const name = String(state.toolCall.name || '');
      const allowed = new Set(state.allowedTools || []);
      const tool = READ_ONLY_TOOLS[name];
      if (tool && allowed.has(name)) {
        const output = tool.run(state);
        return { draft: state.draft ? `${state.draft}\n${output}` : output, toolCall: null };
      }
      const decision = interrupt({
        kind: 'tool_approval',
        tool: name,
        args: state.toolCall.args || {},
        note: 'No write tools are installed. Approval does not run an external action.',
      });
      if (decision === 'approve') {
        return {
          draft: `${state.agentName}: the owner approved "${name}", but no write tools are installed, so nothing ran.`,
          toolCall: null,
        };
      }
      return {
        draft: `${state.agentName}: the owner denied "${name}". No action was taken.`,
        toolCall: null,
      };
    })
    .addEdge(START, 'think')
    .addEdge('think', 'act')
    .addEdge('act', END)
    .compile({ checkpointer: new MemorySaver() });
}

function getRunnable(model) {
  if (!compiledGraphs.has(model)) compiledGraphs.set(model, buildTeamGraph(model));
  return compiledGraphs.get(model);
}

async function invokeAgent(model, agent, context, threadId = crypto.randomUUID()) {
  const graph = getRunnable(model);
  const result = await graph.invoke(graphInput(agent, context), { configurable: { thread_id: threadId } });
  return { ...result, threadId };
}

async function resumeAgent(model, threadId, decision) {
  const graph = getRunnable(model);
  return graph.invoke(new Command({ resume: decision }), { configurable: { thread_id: threadId } });
}

module.exports = { invokeAgent, resumeAgent, parseTools };

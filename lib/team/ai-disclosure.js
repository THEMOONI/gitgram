const ORG = 'Scavvers Labs';
const TRADING_REMINDER = 'AI-agent · Demo · Ingen finansiell rådgivning';

function disclosureSentence(name, org = ORG) {
  const agent = String(name || 'AI-agent').replace(/\s+/g, ' ').trim() || 'AI-agent';
  return `Hej, jag är ${agent}, en AI-agent som agerar för ${org} räkning.`;
}

function voiceIntro(name, org = ORG) {
  const agent = String(name || 'AI-agent').replace(/\s+/g, ' ').trim() || 'AI-agent';
  return `Du pratar med en AI-röst. Jag är ${agent} och agerar för ${org} räkning.`;
}

function asksIfHuman(text) {
  const value = String(text || '').toLowerCase().replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ');
  return value.includes('är du en människa')
    || value.includes('ar du en manniska')
    || value.includes('are you human')
    || value.includes('are you a human');
}

function admitsAi(text) {
  return /\bai\b|ai-agent|artificiell intelligens|artificial intelligence|inte en människa|not a human/i.test(String(text || ''));
}

function claimsToBeHuman(text) {
  const value = String(text || '').toLowerCase();
  const claims = value.includes('jag är en människa')
    || value.includes('jag är människa')
    || value.includes('i am a human')
    || value.includes("i'm a human")
    || value.includes('i am human');
  if (!claims) return false;
  if ((value.includes('inte') || value.includes('not') || value.includes('nej')) && admitsAi(value)) return false;
  return true;
}

function truthfulHumanAnswer(name, org = ORG) {
  const agent = String(name || 'AI-agent').replace(/\s+/g, ' ').trim() || 'AI-agent';
  return `Nej. Jag är ${agent}, en AI-agent som agerar för ${org} räkning. Jag är inte en människa.`;
}

function enforceTruthfulIdentity(parentBody, replyBody, name, org = ORG) {
  const reply = String(replyBody || '').trim();
  if (!asksIfHuman(parentBody)) return reply;
  const truth = truthfulHumanAnswer(name, org);
  if (claimsToBeHuman(reply)) return truth;
  if (!admitsAi(reply)) return reply ? `${truth}\n\n${reply}` : truth;
  return reply;
}

function prependDisclosure(body, line) {
  const text = String(body || '').trim();
  const prefix = String(line || '').trim();
  if (!prefix) return text;
  if (text.startsWith(prefix)) return text;
  return text ? `${prefix}\n\n${text}` : prefix;
}

class DisclosureLedger {
  constructor() {
    this.sessions = new Map();
  }

  has(sessionId, agentKey) {
    return this.sessions.get(String(sessionId))?.get(String(agentKey)) === true;
  }

  mark(sessionId, agentKey) {
    const key = String(sessionId);
    if (!this.sessions.has(key)) this.sessions.set(key, new Map());
    this.sessions.get(key).set(String(agentKey), true);
  }
}

function cancelledError() {
  const error = new Error('cancelled');
  error.code = 'CANCELLED';
  return error;
}

function interruptedError() {
  const error = new Error('interrupted');
  error.code = 'INTERRUPTED';
  return error;
}

function brokenError(cause) {
  const error = cause instanceof Error ? cause : new Error('stream broken');
  if (!error.code || error.code === 'ERR_STREAM') error.code = 'STREAM_BROKEN';
  if (error.code !== 'STREAM_BROKEN' && error.code !== 'CANCELLED' && error.code !== 'INTERRUPTED') {
    error.code = 'STREAM_BROKEN';
  }
  return error;
}

/**
 * Send the art. 50.1 line, then the model text.
 * The ledger is updated only after `write` of the disclosure chunk resolves.
 * A cancel, interrupt, or broken stream before that resolve leaves the agent undisclosed.
 */
async function deliverDisclosedReply({
  ledger,
  sessionId,
  agentKey,
  agentName,
  org = ORG,
  write,
  signal,
  model,
  interruptBeforeSend = false,
}) {
  const line = disclosureSentence(agentName, org);
  const already = ledger.has(sessionId, agentKey);

  if (!already && interruptBeforeSend) throw interruptedError();
  if (!already && signal?.aborted) throw cancelledError();

  let disclosed = already;
  if (!already) {
    try {
      await write({ type: 'disclosure', text: line });
    } catch (error) {
      throw brokenError(error);
    }
    if (signal?.aborted) {
      ledger.mark(sessionId, agentKey);
      const error = cancelledError();
      error.disclosed = true;
      throw error;
    }
    ledger.mark(sessionId, agentKey);
    disclosed = true;
  }

  let modelText = '';
  try {
    if (signal?.aborted) throw cancelledError();
    modelText = await model();
    if (signal?.aborted) throw cancelledError();
  } catch (error) {
    if (disclosed) {
      return { text: line, disclosed: true, partial: true, error };
    }
    throw error;
  }

  const rest = String(modelText || '').trim();
  const text = already ? rest : prependDisclosure(rest, line);
  const extra = already ? rest : (rest.startsWith(line) ? '' : rest);
  if (extra) {
    try {
      await write({ type: 'body', text: already ? rest : extra });
    } catch (error) {
      const broken = brokenError(error);
      broken.disclosed = disclosed;
      throw broken;
    }
  }
  return { text, disclosed: ledger.has(sessionId, agentKey), partial: false };
}

function planAgentDisclosure({
  ledger,
  sessionId,
  agentKey,
  agentName,
  body,
  parentBody,
  org = ORG,
}) {
  const line = disclosureSentence(agentName, org);
  const identity = enforceTruthfulIdentity(parentBody, body, agentName, org);
  const needed = !ledger.has(sessionId, agentKey);
  return {
    text: needed ? prependDisclosure(identity, line) : identity,
    line,
    pending: needed,
  };
}

module.exports = {
  ORG,
  TRADING_REMINDER,
  DisclosureLedger,
  disclosureSentence,
  voiceIntro,
  asksIfHuman,
  truthfulHumanAnswer,
  enforceTruthfulIdentity,
  prependDisclosure,
  deliverDisclosedReply,
  planAgentDisclosure,
};

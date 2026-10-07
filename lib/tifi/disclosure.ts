// Art. 50.1 disclosure for TIFI. The ledger flips only after the disclosure
// text has actually been written. A cancel, interrupt, or broken stream
// before that write leaves the tiger undisclosed for the next attempt.

const ORG = 'Scavvers Labs';
const DECISION_REMINDER = 'AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning';

interface NamedError extends Error {
  code: string;
  disclosed?: boolean;
}

interface WriteChunk {
  type: 'disclosure' | 'body';
  text: string;
}

interface DeliverArgs {
  ledger: DisclosureLedger;
  sessionId: string;
  agentKey: string;
  agentName: string;
  org?: string;
  write: (chunk: WriteChunk) => Promise<unknown>;
  signal?: { aborted?: boolean };
  model: () => Promise<string>;
  interruptBeforeSend?: boolean;
}

interface PlanArgs {
  ledger: DisclosureLedger;
  sessionId: string;
  agentKey: string;
  agentName: string;
  body: string;
  parentBody?: string;
  org?: string;
}

interface TigerCard {
  id: number;
  name: string;
  decision?: { rationale?: string };
}

interface FeedItem {
  tigerId?: number;
  tiger?: string;
  rationale?: string;
}

interface BoardLike {
  tigers?: TigerCard[];
  feed?: FeedItem[];
}

function disclosureSentence(name: string, org: string = ORG): string {
  const agent = String(name || 'AI-agent').replace(/\s+/g, ' ').trim() || 'AI-agent';
  return `Hej, jag är ${agent}, en AI-agent som agerar för ${org} räkning.`;
}

function asksIfHuman(text: string): boolean {
  const value = String(text || '').toLowerCase().replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ');
  return value.includes('är du en människa')
    || value.includes('ar du en manniska')
    || value.includes('are you human')
    || value.includes('are you a human');
}

function admitsAi(text: string): boolean {
  return /\bai\b|ai-agent|artificiell intelligens|artificial intelligence|inte en människa|not a human/i.test(String(text || ''));
}

function claimsToBeHuman(text: string): boolean {
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

function truthfulHumanAnswer(name: string, org: string = ORG): string {
  const agent = String(name || 'AI-agent').replace(/\s+/g, ' ').trim() || 'AI-agent';
  return `Nej. Jag är ${agent}, en AI-agent som agerar för ${org} räkning. Jag är inte en människa.`;
}

function enforceTruthfulIdentity(parentBody: string, replyBody: string, name: string, org: string = ORG): string {
  const reply = String(replyBody || '').trim();
  if (!asksIfHuman(parentBody)) return reply;
  const truth = truthfulHumanAnswer(name, org);
  if (claimsToBeHuman(reply)) return truth;
  if (!admitsAi(reply)) return reply ? `${truth}\n\n${reply}` : truth;
  return reply;
}

function prependDisclosure(body: string, line: string): string {
  const text = String(body || '').trim();
  const prefix = String(line || '').trim();
  if (!prefix) return text;
  if (text.startsWith(prefix)) return text;
  return text ? `${prefix}\n\n${text}` : prefix;
}

class DisclosureLedger {
  sessions: Map<string, Map<string, boolean>>;

  constructor() {
    this.sessions = new Map();
  }

  has(sessionId: string, agentKey: string): boolean {
    const bucket = this.sessions.get(String(sessionId));
    return bucket ? bucket.get(String(agentKey)) === true : false;
  }

  mark(sessionId: string, agentKey: string): void {
    const key = String(sessionId);
    if (!this.sessions.has(key)) this.sessions.set(key, new Map());
    this.sessions.get(key)!.set(String(agentKey), true);
  }
}

function cancelledError(): NamedError {
  const error = new Error('cancelled') as NamedError;
  error.code = 'CANCELLED';
  return error;
}

function interruptedError(): NamedError {
  const error = new Error('interrupted') as NamedError;
  error.code = 'INTERRUPTED';
  return error;
}

function brokenError(cause: unknown): NamedError {
  const error = (cause instanceof Error ? cause : new Error('stream broken')) as NamedError;
  if (!error.code || error.code === 'ERR_STREAM') error.code = 'STREAM_BROKEN';
  if (error.code !== 'STREAM_BROKEN' && error.code !== 'CANCELLED' && error.code !== 'INTERRUPTED') {
    error.code = 'STREAM_BROKEN';
  }
  return error;
}

/**
 * Send the art. 50.1 line, then the model text.
 * The ledger is updated only after `write` of the disclosure chunk resolves.
 */
async function deliverDisclosedReply(args: DeliverArgs): Promise<{ text: string; disclosed: boolean; partial: boolean; error?: unknown }> {
  const org = args.org || ORG;
  const line = disclosureSentence(args.agentName, org);
  const already = args.ledger.has(args.sessionId, args.agentKey);
  const signal = args.signal;

  if (!already && args.interruptBeforeSend) throw interruptedError();
  if (!already && signal && signal.aborted) throw cancelledError();

  let disclosed = already;
  if (!already) {
    try {
      await args.write({ type: 'disclosure', text: line });
    } catch (error) {
      throw brokenError(error);
    }
    if (signal && signal.aborted) {
      args.ledger.mark(args.sessionId, args.agentKey);
      const error = cancelledError();
      error.disclosed = true;
      throw error;
    }
    args.ledger.mark(args.sessionId, args.agentKey);
    disclosed = true;
  }

  let modelText = '';
  try {
    if (signal && signal.aborted) throw cancelledError();
    modelText = await args.model();
    if (signal && signal.aborted) throw cancelledError();
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
      await args.write({ type: 'body', text: already ? rest : extra });
    } catch (error) {
      const broken = brokenError(error);
      broken.disclosed = disclosed;
      throw broken;
    }
  }
  return { text, disclosed: args.ledger.has(args.sessionId, args.agentKey), partial: false };
}

function planTigerDisclosure(args: PlanArgs): { text: string; line: string; pending: boolean } {
  const org = args.org || ORG;
  const line = disclosureSentence(args.agentName, org);
  const identity = enforceTruthfulIdentity(args.parentBody || '', args.body, args.agentName, org);
  const needed = !args.ledger.has(args.sessionId, args.agentKey);
  return {
    text: needed ? prependDisclosure(identity, line) : identity,
    line,
    pending: needed,
  };
}

function tigerAgentKey(tigerId: number): string {
  return 'tiger:' + tigerId;
}

function presentSessionBoard(board: BoardLike, ledger: DisclosureLedger, sessionId: string): string[] {
  const pending: string[] = [];
  const tigers = board && Array.isArray(board.tigers) ? board.tigers : [];
  for (const tiger of tigers) {
    const key = tigerAgentKey(tiger.id);
    const plan = planTigerDisclosure({
      ledger,
      sessionId,
      agentKey: key,
      agentName: tiger.name,
      body: tiger.decision && tiger.decision.rationale ? tiger.decision.rationale : '',
    });
    if (tiger.decision) tiger.decision.rationale = plan.text;
    if (plan.pending) pending.push(key);
  }
  const seen = new Set<string>();
  const feed = board && Array.isArray(board.feed) ? board.feed : [];
  for (const item of feed) {
    if (item.tigerId == null) continue;
    const key = tigerAgentKey(item.tigerId);
    if (!pending.includes(key) || seen.has(key)) continue;
    seen.add(key);
    item.rationale = prependDisclosure(item.rationale || '', disclosureSentence(item.tiger || 'TIFI'));
  }
  return pending;
}

function commitDisclosure(
  res: { statusCode?: number; once: (event: string, fn: () => void) => void },
  ledger: DisclosureLedger,
  sessionId: string,
  keys: string[],
): void {
  if (!keys.length) return;
  res.once('finish', () => {
    if ((res.statusCode || 0) >= 400) return;
    for (const key of keys) ledger.mark(sessionId, key);
  });
}

module.exports = {
  ORG,
  DECISION_REMINDER,
  DisclosureLedger,
  disclosureSentence,
  asksIfHuman,
  truthfulHumanAnswer,
  enforceTruthfulIdentity,
  prependDisclosure,
  deliverDisclosedReply,
  planTigerDisclosure,
  tigerAgentKey,
  presentSessionBoard,
  commitDisclosure,
};

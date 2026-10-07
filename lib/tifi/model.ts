// Decision model. The default is local and deterministic. An optional network
// adapter is constructed only when OPENAI_API_KEY is provided by the caller.

interface Probabilities {
  buy: number;
  sell: number;
  hold: number;
}

interface SignalLike {
  action: 'enter' | 'exit' | 'hold';
  symbol: string | null;
  strength: number;
  stopPct: number;
  note: string;
  agentName?: string;
}

const { enforceTruthfulIdentity } = require('./disclosure.ts') as {
  enforceTruthfulIdentity: (parentBody: string, replyBody: string, name: string) => string;
};

interface LimitsLike {
  maxPositionPct: number;
  maxStopPct: number;
}

interface Proposal {
  action: 'buy' | 'sell' | 'hold';
  symbol: string | null;
  notionalPct: number | null;
  stopLossPct: number | null;
  leverage: number;
  rationale: string;
  probabilities: Probabilities;
  modelId: string;
  modelCostMicro: number;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function distribution(action: 'buy' | 'sell' | 'hold', strength: number): Probabilities {
  const s = strength < 0 ? 0 : strength > 1 ? 1 : strength;
  let buy = 0.08;
  let sell = 0.08;
  let hold = 0.84;
  if (action === 'buy') {
    buy = 0.5 + 0.4 * s;
    sell = 0.05;
    hold = 1 - buy - sell;
  } else if (action === 'sell') {
    sell = 0.5 + 0.4 * s;
    buy = 0.05;
    hold = 1 - buy - sell;
  } else {
    hold = 0.7 + 0.2 * (1 - s);
    buy = (1 - hold) / 2;
    sell = 1 - hold - buy;
  }
  buy = round3(buy);
  sell = round3(sell);
  hold = round3(1 - buy - sell);
  return { buy, sell, hold };
}

const IDENTITY_RULE = 'Om du får frågan "är du en människa?" eller "are you human?", svara alltid sanningsenligt att du är en AI-agent som agerar för Scavvers Labs räkning. Påstå aldrig att du är en människa.';

function rationaleFor(signal: SignalLike, action: 'buy' | 'sell' | 'hold'): string {
  const symbol = signal.symbol || 'listan';
  const what = action === 'buy'
    ? 'öppna en simulerad position'
    : action === 'sell'
      ? 'stänga en simulerad position'
      : 'avvakta';
  const local = 'Lokal modell, pappersläge. Signal för ' + symbol + ': ' + signal.note
    + ' Föreslagen simulerad åtgärd: ' + what + '. Detta är ingen rekommendation och inget löfte om avkastning.';
  return enforceTruthfulIdentity(signal.note, local, signal.agentName || 'TIFI');
}

function createFakeModel(): { id: string; propose: (signal: SignalLike, limits: LimitsLike) => Promise<Proposal> } {
  return {
    id: 'fake-local',
    async propose(signal: SignalLike, limits: LimitsLike): Promise<Proposal> {
      const action: 'buy' | 'sell' | 'hold' = signal.action === 'enter' ? 'buy' : signal.action === 'exit' ? 'sell' : 'hold';
      const strength = Number(signal.strength) || 0;
      return {
        action,
        symbol: signal.symbol,
        notionalPct: action === 'buy' ? limits.maxPositionPct : null,
        stopLossPct: action === 'buy' ? Math.min(signal.stopPct || limits.maxStopPct, limits.maxStopPct) : null,
        leverage: 1,
        rationale: rationaleFor(signal, action),
        probabilities: distribution(action, strength),
        modelId: 'fake-local',
        modelCostMicro: 0,
      };
    },
  };
}

function extractJson(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function createOpenAiModel(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  pricePerMillion?: number;
}): { id: string; propose: (signal: SignalLike, limits: LimitsLike) => Promise<Proposal> } {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const model = options.model || 'gpt-4o-mini';
  const pricePerMillion = options.pricePerMillion == null ? 0.15 : options.pricePerMillion;
  const fallback = createFakeModel();
  return {
    id: 'openai',
    async propose(signal: SignalLike, limits: LimitsLike): Promise<Proposal> {
      const local = await fallback.propose(signal, limits);
      try {
        const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + options.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              {
                role: 'system',
                content: 'Svara bara med JSON. Du simulerar pappershandel. Nycklar: action (buy, sell eller hold), leverage (alltid 1), rationale (kort, inte rådgivning). ' + IDENTITY_RULE,
              },
              {
                role: 'user',
                content: JSON.stringify({
                  signal,
                  maxPositionPct: limits.maxPositionPct,
                  maxStopPct: limits.maxStopPct,
                }),
              },
            ],
          }),
        });
        if (!response.ok) return local;
        const body = await response.json() as any;
        const text = body && body.choices && body.choices[0] && body.choices[0].message
          ? String(body.choices[0].message.content || '')
          : '';
        const parsed = extractJson(text);
        const tokens = body && body.usage && body.usage.total_tokens ? Number(body.usage.total_tokens) : 0;
        const usd = tokens * pricePerMillion / 1_000_000;
        const costMicro = Math.round(usd * 1_000_000);
        if (!parsed || (parsed.action !== 'buy' && parsed.action !== 'sell' && parsed.action !== 'hold')) {
          return local;
        }
        const action = parsed.action as 'buy' | 'sell' | 'hold';
        return {
          action,
          symbol: signal.symbol,
          notionalPct: action === 'buy' ? limits.maxPositionPct : null,
          stopLossPct: action === 'buy' ? limits.maxStopPct : null,
          leverage: 1,
          rationale: enforceTruthfulIdentity(
          signal.note,
          'Nätverksmodell, pappersläge. ' + String(parsed.rationale || signal.note).slice(0, 400)
            + ' Detta är ingen rekommendation.',
          signal.agentName || 'TIFI',
        ),
          probabilities: distribution(action, signal.strength || 0.5),
          modelId: 'openai',
          modelCostMicro: costMicro,
        };
      } catch {
        return local;
      }
    },
  };
}

function createDecisionModel(env: Record<string, string | undefined> | null | undefined, deps?: { fetchImpl?: typeof fetch }): {
  id: string;
  propose: (signal: SignalLike, limits: LimitsLike) => Promise<Proposal>;
} {
  const key = env && typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (!key) return createFakeModel();
  return createOpenAiModel({ apiKey: key, fetchImpl: deps && deps.fetchImpl });
}

module.exports = {
  distribution,
  IDENTITY_RULE,
  createFakeModel,
  createOpenAiModel,
  createDecisionModel,
};

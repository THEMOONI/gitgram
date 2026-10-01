// Display names for the paper 15-minute markets. The default copy is the
// internal one. TIFI_MARKET_LABELS=neutral is for a later, reviewed display.

function neutralLabels(env?: Record<string, string | undefined>): boolean {
  return String(env && env.TIFI_MARKET_LABELS || '').trim().toLowerCase() === 'neutral';
}

function inferUnderlying(seriesTicker: string | null | undefined): string {
  const name = String(seriesTicker || '').toUpperCase();
  if (name.includes('ETH')) return 'ETH';
  if (name.includes('SOL')) return 'SOL';
  if (name.includes('BTC')) return 'BTC';
  return '';
}

function displaySeries(
  underlying: string | null | undefined,
  seriesTicker?: string | null,
  env?: Record<string, string | undefined>,
): string {
  const ticker = String(seriesTicker || '');
  if (!neutralLabels(env)) return ticker;
  const key = String(underlying || inferUnderlying(ticker)).toUpperCase();
  if (key === 'BTC') return 'SIM-BTC-15M';
  if (key === 'ETH') return 'SIM-ETH-15M';
  if (key === 'SOL') return 'SIM-SOL-15M';
  if (key) return 'SIM-' + key + '-15M';
  return 'SIM-15M';
}

function marketCopy(env?: Record<string, string | undefined>): {
  neutral: boolean;
  title: string;
  venueLabel: string;
  venueChip: string;
  venueOption: string;
  paperOption: string;
  emptyPosition: string;
  flashVenue: string;
  rationaleSuffix: string;
  feeNote: (coef: number) => string;
} {
  const neutral = neutralLabels(env);
  return {
    neutral,
    title: neutral
      ? '15-minutersmarknader (papper, endast eget bruk, simulerat/kedjedata)'
      : 'World-marknader (papper, endast eget bruk, simulerat/kedjedata)',
    venueLabel: neutral ? '15-minutersmarknader' : 'World-marknader',
    venueChip: neutral ? '15 min (papper)' : 'World (papper)',
    venueOption: neutral ? '15-minutersmarknader (papper)' : 'World-marknader (papper)',
    paperOption: 'Befintlig pappersmarknad',
    emptyPosition: neutral ? 'Ingen öppen position.' : 'Ingen öppen World-position.',
    flashVenue: neutral ? '15-minutersmarknader (papper)' : 'World-marknader (papper)',
    rationaleSuffix: neutral
      ? ' Förslaget gäller pappersandelar i en 15-minutersmarknad, inte en riktig order och ingen rekommendation.'
      : ' Förslaget gäller pappersandelar i en 15-minuters World-marknad, inte en riktig order och ingen rekommendation.',
    feeNote(coef: number): string {
      const tail = neutral ? 'avgift.' : 'World-avgift.';
      return 'Avgift ' + coef + '×(1−p) bps per avslut är en obekräftad tredjepartsuppskattning, inte en bekräftad ' + tail;
    },
  };
}

function publicText(value: unknown, env?: Record<string, string | undefined>): string {
  const text = value == null ? '' : String(value);
  if (!neutralLabels(env) || !text) return text;
  if (text.includes('Riktiga pengar är inte tillåtna') && text.includes('World')) {
    return 'Riktiga pengar är inte tillåtna. Juridisk granskning har sagt nej. Inga riktiga order skickas.';
  }
  return text
    .replace(/15-minuters World-marknad/g, '15-minutersmarknad')
    .replace(/World-marknader \(papper, endast eget bruk, simulerat\/kedjedata\)/g, '15-minutersmarknader (papper, endast eget bruk, simulerat/kedjedata)')
    .replace(/World-marknader \(papper\)/g, '15-minutersmarknader (papper)')
    .replace(/World-marknader/g, '15-minutersmarknader')
    .replace(/World-marknad/g, '15-minutersmarknad')
    .replace(/World-position/g, 'position')
    .replace(/World-order/g, 'order')
    .replace(/World-insats/g, 'insats')
    .replace(/World-avgift/g, 'avgift')
    .replace(/WXBTC15M/g, 'SIM-BTC-15M')
    .replace(/WXETH15M/g, 'SIM-ETH-15M')
    .replace(/WXSOL15M/g, 'SIM-SOL-15M')
    .replace(/\bWorld\b/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,])/g, '$1');
}

module.exports = {
  neutralLabels,
  displaySeries,
  marketCopy,
  publicText,
};

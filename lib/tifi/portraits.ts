// Local portraits from the design drop-in. Replace the files in
// public/tifi/portraits (same names) without changing this module.
// A portrait stays on the placeholder until it has been generated.

const SLOTS = [1, 2, 3];

function slotOf(slot: number): number {
  return SLOTS.includes(slot) ? slot : 1;
}

function portraitFile(slot: number, ready?: boolean): string {
  if (!ready) return '/tifi/portraits/tifi-placeholder.png';
  return '/tifi/portraits/tifi-' + slotOf(slot) + '.png';
}

function portraitThumb(slot: number, ready?: boolean): string {
  if (!ready) return '/tifi/portraits/tifi-placeholder-256.png';
  return '/tifi/portraits/tifi-' + slotOf(slot) + '-256.png';
}

function fallbackMascot(): string {
  return '/tifi/brand/tifi-mascot-clean.png';
}

function variantSrc(slot: number, ready?: boolean): string {
  return portraitThumb(slot, ready);
}

function nextVariant(current: number): number {
  const index = SLOTS.indexOf(current);
  return SLOTS[(index + 1) % SLOTS.length];
}

async function optionalExternalPortrait(env: Record<string, string | undefined> | undefined, fetchImpl?: typeof fetch): Promise<null | { skipped: boolean }> {
  const key = env && env.TIFI_IMAGE_API_KEY ? String(env.TIFI_IMAGE_API_KEY).trim() : '';
  const url = env && env.TIFI_IMAGE_API_URL ? String(env.TIFI_IMAGE_API_URL).trim() : '';
  if (!key || !url || !fetchImpl) return null;
  return { skipped: true };
}

module.exports = {
  SLOTS,
  portraitFile,
  portraitThumb,
  fallbackMascot,
  variantSrc,
  nextVariant,
  optionalExternalPortrait,
};

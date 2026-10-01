const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const SILENCE_MS = 10 * 60 * 1000;
const PUSH_CAP = 5;

function stockholmHour(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0');
  if (!Number.isFinite(hour) || hour === 24) return 0;
  return hour;
}

function parseQuietHours(value) {
  if (value == null) return { start: 0, end: 7 };
  if (value === false || value === 'off') return null;
  const match = String(value).trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return { start: 0, end: 7 };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { start: 0, end: 7 };
  if (start < 0 || start > 23 || end < 1 || end > 24 || start >= end) return { start: 0, end: 7 };
  return { start, end };
}

function isQuietHour(date, range) {
  if (!range) return false;
  const hour = stockholmHour(date);
  return hour >= range.start && hour < range.end;
}

function eligibleForNotice(alert, minLiquidity) {
  const followUp = alert.stage === 'uppföljning';
  const migration = alert.source === 'pumpportal-migrering';
  const severity = alert.label === 'LÅG' || alert.label === 'MEDEL';
  const liquid = typeof alert.liquidityUsd === 'number'
    && Number.isFinite(alert.liquidityUsd)
    && alert.liquidityUsd >= minLiquidity;
  return severity && liquid && alert.stage !== 'snabb' && (followUp || migration);
}

function decideNotification({ alert, now, silent, minLiquidity, quiet, recentMint, recentPushCount }) {
  if (silent || !eligibleForNotice(alert, minLiquidity)) return { action: 'none', sound: false };
  if (recentMint) return { action: 'none', sound: false };
  if (recentPushCount >= PUSH_CAP) return { action: 'overflow', sound: !quiet };
  if (quiet) return { action: 'quiet', sound: false };
  return { action: 'push', sound: true };
}

function watcherIsSilent(state, now) {
  if (!state || !state.configured) return false;
  if (state.pumpportalConnected === false) return true;
  if (state.lastEventMs && now - state.lastEventMs >= SILENCE_MS) return true;
  if (!state.lastEventMs && !state.streamConnected) return true;
  return false;
}

module.exports = {
  SIX_HOURS_MS,
  TEN_MINUTES_MS,
  SILENCE_MS,
  PUSH_CAP,
  stockholmHour,
  parseQuietHours,
  isQuietHour,
  eligibleForNotice,
  decideNotification,
  watcherIsSilent,
};

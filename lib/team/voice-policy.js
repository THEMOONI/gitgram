const STANDARD_VOICES = Object.freeze({
  openai: Object.freeze([
    'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
  ]),
  fake: Object.freeze(['alloy']),
});

const BANNED = /sentiment|emotion|emotions|diari[sz]e|diarization|speaker[_\s-]?label|speaker[_\s-]?id|voiceprint|voice[_\s-]?login|voice[_\s-]?id|voice[_\s-]?clone|clon(e|ing)|identify[_\s-]?speaker/i;
const VOICE_ENV = /^(VOICE_|STT_|TTS_|SPEECH_|WHISPER_)/;

function voicePolicyError(message) {
  const error = new Error(message);
  error.code = 'VOICE_POLICY';
  return error;
}

function standardVoices(provider) {
  return STANDARD_VOICES[provider] || STANDARD_VOICES.openai;
}

function assertStandardVoice(provider, voice) {
  const name = String(voice || '').trim();
  const allow = new Set(standardVoices(provider));
  if (!allow.has(name)) {
    throw voicePolicyError(
      `Voice "${name || '(empty)'}" is not an allowlisted synthetic voice. Custom voice IDs, voice-sample uploads, and voice cloning are rejected.`,
    );
  }
  return name;
}

function assertNoBiometricVoice(env = {}) {
  for (const [key, raw] of Object.entries(env)) {
    if (!VOICE_ENV.test(key)) continue;
    if (key === 'TTS_VOICE' || key === 'VOICE_PROVIDER' || key === 'STT_MODEL' || key === 'TTS_MODEL') {
      if (BANNED.test(key)) throw voicePolicyError(`Voice option ${key} is forbidden.`);
      if (BANNED.test(String(raw || '')) && key !== 'TTS_VOICE') {
        throw voicePolicyError(`Voice option ${key} enables a forbidden biometric or emotion feature.`);
      }
      continue;
    }
    if (BANNED.test(key) || BANNED.test(String(raw || ''))) {
      throw voicePolicyError(`Voice option ${key} is forbidden. Sentiment, emotion, speaker identification, and voice cloning stay off.`);
    }
  }
}

function assertNotCloneRequest(input = {}) {
  const pathName = String(input.path || '');
  if (/clone|voice[_-]?sample|voiceprint/i.test(pathName)) {
    throw voicePolicyError('Voice cloning and voice-sample uploads are rejected.');
  }
  const fields = input.fields && typeof input.fields === 'object' ? input.fields : {};
  for (const [key, value] of Object.entries(fields)) {
    if (BANNED.test(key) || BANNED.test(String(value || ''))) {
      throw voicePolicyError(`Voice field ${key} is forbidden.`);
    }
  }
  if (input.sample || input.voiceFile) {
    throw voicePolicyError('Voice-sample uploads are rejected. Milad\'s voice cannot be cloned.');
  }
  if (input.voice) assertStandardVoice(input.provider || 'openai', input.voice);
}

function assertSpeechUrl(url) {
  const value = String(url || '');
  if (/\/audio\/voices|voice[_-]?clone|\/voices\/clone|similarity_boost|voice_settings/i.test(value)) {
    throw voicePolicyError('Voice cloning endpoints are rejected.');
  }
}

const CONSENT_TEXT = 'Spara en inspelning av samtalet i 30 dagar så att jag kan lyssna igen. Jag kan radera den när som helst.';
const CONSENT_VERSION = '2026-10-07';
const MAX_RETAIN_DAYS = 30;

function safeVoiceLog(logger, event) {
  const copy = { ...event };
  for (const key of ['text', 'transcript', 'body', 'audio', 'content', 'sample']) delete copy[key];
  logger(copy);
  return copy;
}

module.exports = {
  STANDARD_VOICES,
  CONSENT_TEXT,
  CONSENT_VERSION,
  MAX_RETAIN_DAYS,
  voicePolicyError,
  assertStandardVoice,
  assertNoBiometricVoice,
  assertNotCloneRequest,
  assertSpeechUrl,
  safeVoiceLog,
};

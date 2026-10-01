const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadTeamConfig } = require('./config');

function wavFromText() {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * 0.2);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.2;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const DEFAULT_DISCLOSURE = 'Du pratar med en AI-agent';

function spokenText(body, options = {}) {
  const text = String(body || '').replace(/\u0000/g, '').trim();
  const disclosure = String(options.disclosure || DEFAULT_DISCLOSURE).trim();
  if (!options.disclose) return text;
  if (!disclosure) return text;
  if (text.startsWith(disclosure)) return text;
  return text ? `${disclosure}. ${text}` : disclosure;
}

function voiceRetentionEnabled(config = {}, env = process.env, override) {
  if (override === true || override === false) return override;
  const flag = env && env.TEAM_RETAIN_VOICE;
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return config.retainVoiceAudio === true;
}

function discardAudio(buffer) {
  if (Buffer.isBuffer(buffer) && buffer.length) buffer.fill(0);
}

function retainAudioFile(dataDir, buffer, mime) {
  const dir = path.join(dataDir, 'voice-retained');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const type = String(mime || '');
  const ext = type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : 'bin';
  const file = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.${ext}`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return file;
}

function createFakeVoice() {
  return {
    name: 'fake',
    available: true,
    sendsAudioToCloud: false,
    lastSpoken: '',
    async transcribe() {
      return { text: 'voice note from the team' };
    },
    async synthesize(text) {
      this.lastSpoken = String(text || '');
      return { audio: wavFromText(), contentType: 'audio/wav' };
    },
  };
}

function unavailableError() {
  const error = new Error('Voice is not configured');
  error.code = 'VOICE_UNAVAILABLE';
  return error;
}

function createUnavailableVoice() {
  return {
    name: 'none',
    available: false,
    sendsAudioToCloud: false,
    async transcribe() {
      throw unavailableError();
    },
    async synthesize() {
      throw unavailableError();
    },
  };
}

function createOpenAIVoice(env = process.env) {
  const key = env.OPENAI_API_KEY;
  return {
    name: 'openai',
    available: Boolean(key),
    sendsAudioToCloud: true,
    lastSpoken: '',
    async transcribe(buffer, mime) {
      if (!key) throw unavailableError();
      const form = new FormData();
      const type = mime && mime.startsWith('audio/') ? mime : 'audio/webm';
      form.append('file', new Blob([buffer], { type }), 'speech.webm');
      form.append('model', env.STT_MODEL || 'whisper-1');
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`speech-to-text failed (${response.status})`);
      const data = await response.json();
      return { text: String(data.text || '').trim() };
    },
    async synthesize(text) {
      this.lastSpoken = String(text || '');
      if (!key) throw unavailableError();
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: env.TTS_MODEL || 'tts-1',
          voice: env.TTS_VOICE || 'alloy',
          input: String(text || '').slice(0, 4000),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`text-to-speech failed (${response.status})`);
      return {
        audio: Buffer.from(await response.arrayBuffer()),
        contentType: 'audio/mpeg',
      };
    },
  };
}

function createVoiceProvider(env = process.env) {
  const choice = String(env.VOICE_PROVIDER || '').toLowerCase();
  if (choice === 'fake') return createFakeVoice();
  if (choice === 'none' || choice === 'off') return createUnavailableVoice();
  if (choice === 'openai' || (!choice && env.OPENAI_API_KEY)) {
    return env.OPENAI_API_KEY ? createOpenAIVoice(env) : createUnavailableVoice();
  }
  return createUnavailableVoice();
}

function voiceNotice(config = loadTeamConfig()) {
  return config.voiceUnavailableNotice;
}

module.exports = {
  createFakeVoice,
  createUnavailableVoice,
  createOpenAIVoice,
  createVoiceProvider,
  voiceNotice,
  voiceRetentionEnabled,
  spokenText,
  discardAudio,
  retainAudioFile,
  wavFromText,
  DEFAULT_DISCLOSURE,
};

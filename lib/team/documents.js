const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractPdfText } = require('./pdf');

function safeDisplayName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '').slice(0, 80);
  return base || 'file';
}

function extensionOf(name) {
  const match = safeDisplayName(name).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : '';
}

function looksLikeText(buffer) {
  if (!buffer.length || buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 2000));
  let weird = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) weird += 1;
  }
  return weird / sample.length < 0.02;
}

function readDocument(file, limits) {
  if (!file || !file.name || !Buffer.isBuffer(file.buffer)) return { ok: false, error: 'file_type' };
  if (file.buffer.length === 0) return { ok: false, error: 'file_empty' };
  if (file.buffer.length > limits.maxUploadBytes) return { ok: false, error: 'file_size' };
  const ext = extensionOf(file.name);
  if (!['.txt', '.md', '.pdf'].includes(ext)) return { ok: false, error: 'file_type' };
  let text = '';
  let mime = 'text/plain';
  if (ext === '.pdf') {
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, error: 'file_type' };
    mime = 'application/pdf';
    try {
      text = extractPdfText(file.buffer);
    } catch {
      return { ok: false, error: 'pdf_unreadable' };
    }
    if (!text) return { ok: false, error: 'pdf_unreadable' };
  } else {
    if (!looksLikeText(file.buffer)) return { ok: false, error: 'file_type' };
    mime = ext === '.md' ? 'text/markdown' : 'text/plain';
    text = file.buffer.toString('utf8');
  }
  text = text.replace(/\u0000/g, '').slice(0, limits.maxExtractedChars);
  if (!text.trim()) return { ok: false, error: 'file_empty' };
  return {
    ok: true,
    document: {
      originalName: safeDisplayName(file.name),
      mime,
      buffer: file.buffer,
      text,
    },
  };
}

function readPastedContract(text, limits) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (text.length > limits.contractPasteMaxChars) return { ok: false, error: 'file_size' };
  const cleaned = text.replace(/\u0000/g, '').slice(0, limits.maxExtractedChars);
  return {
    ok: true,
    document: {
      originalName: 'contract.txt',
      mime: 'text/plain',
      buffer: Buffer.from(cleaned, 'utf8'),
      text: cleaned,
    },
  };
}

function storeDocument(dataDir, roomId, document) {
  const dir = path.join(dataDir, 'uploads', String(roomId));
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${crypto.randomBytes(16).toString('hex')}.bin`;
  const full = path.join(dir, stored);
  fs.writeFileSync(full, document.buffer, { mode: 0o600 });
  return path.join('uploads', String(roomId), stored);
}

module.exports = {
  safeDisplayName,
  readDocument,
  readPastedContract,
  storeDocument,
  looksLikeText,
};

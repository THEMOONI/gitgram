const zlib = require('zlib');

const MAX_INFLATED = 5_000_000;

function decodePdfString(value) {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8) & 0xff));
}

function stringsFromOperators(buffer) {
  const text = buffer.toString('latin1');
  const out = [];
  const re = /\((?:\\.|[^\\)])*\)/g;
  let match;
  while ((match = re.exec(text))) {
    const decoded = decodePdfString(match[0].slice(1, -1)).replace(/\s+/g, ' ').trim();
    if (decoded) out.push(decoded);
  }
  return out;
}

function findStreams(buffer) {
  const streams = [];
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let from = 0;
  while (from < buffer.length) {
    const start = buffer.indexOf(marker, from);
    if (start < 0) break;
    let dataStart = start + marker.length;
    if (buffer[dataStart] === 13 && buffer[dataStart + 1] === 10) dataStart += 2;
    else if (buffer[dataStart] === 10) dataStart += 1;
    const end = buffer.indexOf(endMarker, dataStart);
    if (end < 0) break;
    let dataEnd = end;
    if (buffer[dataEnd - 1] === 10) dataEnd -= 1;
    if (buffer[dataEnd - 1] === 13) dataEnd -= 1;
    const headerStart = Math.max(0, buffer.lastIndexOf(Buffer.from('<<'), start));
    const header = buffer.subarray(headerStart, start).toString('latin1');
    streams.push({ header, data: buffer.subarray(dataStart, Math.max(dataStart, dataEnd)) });
    from = end + endMarker.length;
  }
  return streams;
}

function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  const parts = [];
  for (const stream of findStreams(buffer)) {
    let data = stream.data;
    if (/FlateDecode/.test(stream.header)) {
      try {
        data = zlib.inflateSync(data);
      } catch {
        try {
          data = zlib.inflateRawSync(stream.data);
        } catch {
          continue;
        }
      }
      if (data.length > MAX_INFLATED) continue;
    }
    parts.push(...stringsFromOperators(data));
  }
  if (!parts.length) parts.push(...stringsFromOperators(buffer));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = { extractPdfText, decodePdfString };

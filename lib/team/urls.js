function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return '';
  if (/[\u0000-\u001F\s]/.test(value)) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  return url.href;
}

module.exports = { safeHttpUrl };

const ENGLISH = /\b(?:buy|sell|buying|selling|bought|sold)\b/i;
const SWEDISH = /(?:^|[^\p{L}\p{N}])(?:köp|köpa|köper|köpte|köpt|sälj|sälja|säljer|sålde|sålt)(?=$|[^\p{L}\p{N}])/iu;
const ASCII = /(?:^|[^a-z])(?:kop|kopa|salj|salja)(?=$|[^a-z])/i;

function hasTradeWording(value) {
  const text = String(value || '');
  if (!text) return false;
  return ENGLISH.test(text) || SWEDISH.test(text) || ASCII.test(text);
}

function redactText(value) {
  const text = String(value || '');
  if (!text) return '';
  if (hasTradeWording(text)) return '[dolt: handelsuppmaning]';
  return text;
}

function fieldsHaveTradeWording(fields) {
  return fields.some((field) => hasTradeWording(field));
}

module.exports = { hasTradeWording, redactText, fieldsHaveTradeWording };

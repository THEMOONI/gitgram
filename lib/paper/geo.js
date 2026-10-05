// The operator supplies the country. This process does not call a geolocation vendor.
function resolveGeo(options, env) {
  const src = options || {};
  const source = env || process.env;
  const raw = src.blockCountries != null
    ? src.blockCountries
    : (source.GITGRAM_GEO_BLOCK_COUNTRIES || '');
  const list = Array.isArray(raw)
    ? raw
    : String(raw).split(',');
  const blockCountries = list.map((code) => String(code).trim().toUpperCase()).filter(Boolean);
  const headerName = String(src.headerName || source.GITGRAM_GEO_COUNTRY_HEADER || 'x-country-code').toLowerCase();
  let failClosed = src.failClosed;
  if (failClosed == null) failClosed = source.GITGRAM_GEO_FAIL_CLOSED === '1';
  return { blockCountries, headerName, failClosed: !!failClosed };
}

function countryFromRequest(req, geo) {
  if (!req || !geo) return '';
  const value = req.get(geo.headerName);
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function checkGeo(req, geo) {
  const config = geo || resolveGeo();
  if (!config.blockCountries.length && !config.failClosed) {
    return { ok: true, country: countryFromRequest(req, config), configured: false };
  }
  const country = countryFromRequest(req, config);
  if (!country) {
    if (config.failClosed && config.blockCountries.length) {
      return { ok: false, country: '', reason: 'missing' };
    }
    return { ok: true, country: '', configured: config.blockCountries.length > 0 };
  }
  if (config.blockCountries.includes(country)) {
    return { ok: false, country, reason: 'blocked' };
  }
  return { ok: true, country, configured: true };
}

module.exports = {
  resolveGeo,
  checkGeo,
  countryFromRequest,
};

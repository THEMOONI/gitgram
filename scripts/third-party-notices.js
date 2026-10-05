const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const outputPath = path.join(rootDir, 'THIRD_PARTY_NOTICES.md');

function formatLicense(value) {
  if (!value) return 'UNKNOWN';
  if (typeof value === 'string') {
    const text = value.trim();
    return text || 'UNKNOWN';
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => formatLicense(entry.type || entry)).filter((entry) => entry !== 'UNKNOWN');
    return parts.length ? parts.join(' OR ') : 'UNKNOWN';
  }
  if (typeof value === 'object' && value.type) return formatLicense(value.type);
  return 'UNKNOWN';
}

function resolveDep(packages, fromPath, name) {
  let base = fromPath;
  while (true) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const parts = base.split('/');
    const modulesAt = parts.lastIndexOf('node_modules');
    base = modulesAt <= 0 ? '' : parts.slice(0, modulesAt).join('/');
  }
}

function readLicense(pkgPath, meta) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, pkgPath, 'package.json'), 'utf8'));
    if (pkg.license) return formatLicense(pkg.license);
    if (pkg.licenses) return formatLicense(pkg.licenses);
  } catch {
    // Fall back to the lockfile entry when the installed package is absent.
  }
  return formatLicense(meta && meta.license);
}

function collectProductionNotices(lock) {
  const packages = lock.packages || {};
  const root = packages[''] || {};
  const seen = new Set();
  const queue = [];
  for (const name of Object.keys(root.dependencies || {})) queue.push({ from: '', name });
  for (const name of Object.keys(root.optionalDependencies || {})) queue.push({ from: '', name });

  const notices = [];
  while (queue.length) {
    const { from, name } = queue.shift();
    const pkgPath = resolveDep(packages, from, name);
    if (!pkgPath || seen.has(pkgPath)) continue;
    seen.add(pkgPath);
    const meta = packages[pkgPath] || {};
    notices.push({
      name,
      version: meta.version || 'UNKNOWN',
      license: readLicense(pkgPath, meta),
    });
    const next = Object.assign({}, meta.dependencies, meta.optionalDependencies);
    for (const depName of Object.keys(next)) queue.push({ from: pkgPath, name: depName });
  }

  notices.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)) || a.license.localeCompare(b.license));
  const unique = [];
  const seenNotice = new Set();
  for (const entry of notices) {
    const key = `${entry.name}\0${entry.version}\0${entry.license}`;
    if (seenNotice.has(key)) continue;
    seenNotice.add(key);
    unique.push(entry);
  }
  return unique;
}

function licenseFlag(license) {
  const text = String(license).toUpperCase();
  if (!text || text === 'UNKNOWN' || text === 'UNLICENSED' || text.includes('SEE LICENSE')) return 'unknown';
  if (text.includes('AGPL')) return 'AGPL';
  if (text.includes('LGPL')) return 'LGPL';
  if (text.includes('GPL')) return 'GPL';
  return null;
}

function render(notices) {
  const flagged = notices.filter((entry) => licenseFlag(entry.license));
  const lines = [
    '# Third-party notices',
    '',
    'Production dependencies of Gitgram, including transitive dependencies.',
    'DevDependencies are omitted. Regenerate this file with `npm run licenses` after changing `package-lock.json`.',
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
  ];
  for (const entry of notices) {
    const license = entry.license.replace(/\|/g, '\\|');
    lines.push(`| ${entry.name} | ${entry.version} | ${license} |`);
  }
  lines.push('', '## License review', '');
  if (!flagged.length) {
    lines.push('No GPL, AGPL, LGPL, or unknown license was found in this production tree.');
  } else {
    lines.push('These packages need a human review before release:');
    lines.push('');
    for (const entry of flagged) {
      lines.push(`- ${entry.name}@${entry.version} (${licenseFlag(entry.license)}): ${entry.license}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
  const notices = collectProductionNotices(lock);
  const markdown = render(notices);
  fs.writeFileSync(outputPath, markdown);
  const flagged = notices.filter((entry) => licenseFlag(entry.license));
  console.log(`Wrote ${notices.length} production packages to THIRD_PARTY_NOTICES.md`);
  if (flagged.length) {
    console.log('Packages flagged for license review:');
    for (const entry of flagged) console.log(`- ${entry.name}@${entry.version}: ${entry.license}`);
  } else {
    console.log('No GPL, AGPL, LGPL, or unknown licenses.');
  }
}

module.exports = { collectProductionNotices, licenseFlag, render };

if (require.main === module) main();

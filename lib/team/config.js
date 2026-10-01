const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'config');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

function loadTeamConfig() {
  const team = readJson('team.json');
  const legal = readJson('legal-areas.json');
  const agentsFile = readJson('agents.json');
  return {
    ...team,
    legal,
    agents: agentsFile.agents,
    channels: agentsFile.channels,
    sharedBoundaries: agentsFile.sharedBoundaries || '',
    areaLabels: legal.areas.map((area) => area.label),
  };
}

function resolveMaxHops(config, env = process.env, override) {
  const candidate = override != null && override !== '' ? override : env.TEAM_MAX_HOPS;
  if (candidate == null || candidate === '') return config.maxHops;
  const parsed = Number(candidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) return config.maxHops;
  return parsed;
}

module.exports = { loadTeamConfig, resolveMaxHops };

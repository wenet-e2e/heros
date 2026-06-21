import fs from 'node:fs';
import path from 'node:path';

const SKILL_FILE_NAME = 'skill.json';
const VALID_SKILL_ID = /^[a-z][a-z0-9_-]{1,63}$/;
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high']);
const VALID_HANDLERS = new Set(['local_task_router', 'background_agent']);

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compactArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function normalizeTool(tool) {
  const name = String(tool?.name || '').trim();
  if (!name) {
    throw new Error('Skill tool is missing name');
  }
  const risk = String(tool?.risk || 'low').trim();
  if (!VALID_RISK_LEVELS.has(risk)) {
    throw new Error(`Skill tool ${name} has invalid risk: ${risk}`);
  }
  return {
    name,
    description: String(tool?.description || '').trim(),
    risk,
  };
}

function normalizeCapability(capability) {
  const type = String(capability?.type || '').trim();
  if (!type) {
    throw new Error('Skill capability is missing type');
  }
  const handler = String(capability?.handler || 'background_agent').trim();
  if (!VALID_HANDLERS.has(handler)) {
    throw new Error(`Skill capability ${type} has invalid handler: ${handler}`);
  }
  return {
    type,
    description: String(capability?.description || '').trim(),
    handler,
    risk: VALID_RISK_LEVELS.has(capability?.risk) ? capability.risk : 'low',
  };
}

export function normalizeSkill(raw, { filePath, source }) {
  const id = String(raw?.id || '').trim();
  if (!VALID_SKILL_ID.test(id)) {
    throw new Error(`Invalid skill id in ${filePath}: ${id || '(empty)'}`);
  }
  const version = String(raw?.version || '0.1.0').trim();
  const status = String(raw?.status || 'enabled').trim();
  if (!['enabled', 'disabled'].includes(status)) {
    throw new Error(`Skill ${id} has invalid status: ${status}`);
  }
  const capabilities = Array.isArray(raw?.capabilities)
    ? raw.capabilities.map(normalizeCapability)
    : [];
  const tools = Array.isArray(raw?.tools) ? raw.tools.map(normalizeTool) : [];
  return {
    id,
    name: String(raw?.name || id).trim(),
    version,
    description: String(raw?.description || '').trim(),
    status,
    source,
    filePath,
    triggers: compactArray(raw?.triggers),
    capabilities,
    tools,
    instructions: String(raw?.instructions || '').trim(),
  };
}

function skillDirs(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, SKILL_FILE_NAME)))
    .sort();
}

function loadSkillDir(rootDir, source) {
  return skillDirs(rootDir).map((dir) => {
    const filePath = path.join(dir, SKILL_FILE_NAME);
    return normalizeSkill(readJsonFile(filePath), { filePath, source });
  });
}

export class SkillRegistry {
  constructor(skills = []) {
    this.skills = skills;
  }

  all() {
    return this.skills;
  }

  enabled() {
    return this.skills.filter((skill) => skill.status === 'enabled');
  }

  find(id) {
    return this.skills.find((skill) => skill.id === id) || null;
  }

  findByTaskType(taskType) {
    return this.enabled().find((skill) => skill.capabilities.some((capability) => capability.type === taskType)) || null;
  }

  handledLocally() {
    return [...new Set(this.enabled()
      .flatMap((skill) => skill.capabilities)
      .filter((capability) => capability.handler === 'local_task_router')
      .map((capability) => capability.type))]
      .sort();
  }

  summary() {
    const enabled = this.enabled();
    const capabilities = enabled.flatMap((skill) => skill.capabilities.map((capability) => ({
      ...capability,
      skillId: skill.id,
    })));
    const tools = enabled.flatMap((skill) => skill.tools.map((tool) => ({
      ...tool,
      skillId: skill.id,
    })));
    return {
      total: this.skills.length,
      enabled: enabled.length,
      skills: enabled.map((skill) => ({
        id: skill.id,
        name: skill.name,
        version: skill.version,
        description: skill.description,
        source: skill.source,
        triggers: skill.triggers,
        capabilities: skill.capabilities,
        tools: skill.tools,
      })),
      capabilities,
      tools,
    };
  }

  instructions() {
    return this.enabled()
      .filter((skill) => skill.instructions)
      .map((skill) => `## ${skill.name} (${skill.id})\n${skill.instructions}`)
      .join('\n\n');
  }
}

export function loadSkillRegistry({ dataDir, cwd = process.cwd() } = {}) {
  const builtInDir = path.join(cwd, 'skills');
  const localDir = path.join(dataDir || path.join(cwd, '.heros'), 'skills');
  const loaded = [
    ...loadSkillDir(builtInDir, 'built_in'),
    ...loadSkillDir(localDir, 'local'),
  ];
  const byId = new Map();
  for (const skill of loaded) {
    byId.set(skill.id, skill);
  }
  return {
    registry: new SkillRegistry([...byId.values()].sort((a, b) => a.id.localeCompare(b.id))),
    builtInDir,
    localDir,
  };
}

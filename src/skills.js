import fs from 'node:fs';
import path from 'node:path';

const JSON_SKILL_FILE_NAME = 'skill.json';
const MARKDOWN_SKILL_FILE_NAME = 'SKILL.md';
const VALID_SKILL_ID = /^[a-z][a-z0-9_-]{1,63}$/;
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high']);
const VALID_HANDLERS = new Set(['local_task_router', 'background_agent']);

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseScalar(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return match ? parseScalar(match[1]) : '';
}

function frontmatterBlock(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => line.match(new RegExp(`^${key}:\\s*$`)));
  if (start === -1) {
    return [];
  }
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S[^:]*:\s*/.test(line)) {
      break;
    }
    if (line.trim()) {
      block.push(line);
    }
  }
  return block;
}

function frontmatterStringList(frontmatter, key) {
  return frontmatterBlock(frontmatter, key)
    .map((line) => line.match(/^\s*-\s*(.*)$/)?.[1])
    .filter(Boolean)
    .map(parseScalar);
}

function frontmatterObjectList(frontmatter, key) {
  const items = [];
  let current = null;
  for (const line of frontmatterBlock(frontmatter, key)) {
    const itemMatch = line.match(/^\s*-\s*(.*)$/);
    if (itemMatch) {
      if (current) {
        items.push(current);
      }
      current = {};
      const rest = itemMatch[1].trim();
      const pair = rest.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (pair) {
        current[pair[1]] = parseScalar(pair[2]);
      }
      continue;
    }
    const pair = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair && current) {
      current[pair[1]] = parseScalar(pair[2]);
    }
  }
  if (current) {
    items.push(current);
  }
  return items;
}

function splitMarkdownSkill(content, filePath) {
  if (!content.startsWith('---')) {
    throw new Error(`Missing YAML frontmatter in ${filePath}`);
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid YAML frontmatter in ${filePath}`);
  }
  return {
    frontmatter: match[1],
    body: match[2].trim(),
  };
}

function slugFromName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

export function readMarkdownSkill(filePath, source) {
  const { frontmatter, body } = splitMarkdownSkill(fs.readFileSync(filePath, 'utf8'), filePath);
  const name = frontmatterValue(frontmatter, 'name');
  const description = frontmatterValue(frontmatter, 'description');
  const id = frontmatterValue(frontmatter, 'id') || slugFromName(name) || path.basename(path.dirname(filePath));
  const capabilities = frontmatterObjectList(frontmatter, 'capabilities');
  const tools = frontmatterObjectList(frontmatter, 'tools');
  return normalizeSkill({
    id,
    name,
    description,
    version: frontmatterValue(frontmatter, 'version') || '0.1.0',
    status: frontmatterValue(frontmatter, 'status') || 'enabled',
    triggers: frontmatterStringList(frontmatter, 'triggers'),
    capabilities: capabilities.length > 0 ? capabilities : [
      {
        type: id,
        description,
        handler: 'background_agent',
        risk: 'medium',
      },
    ],
    tools,
    instructions: body,
  }, { filePath, source });
}

function skillDirs(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .filter((dir) => (
      fs.existsSync(path.join(dir, MARKDOWN_SKILL_FILE_NAME))
      || fs.existsSync(path.join(dir, JSON_SKILL_FILE_NAME))
    ))
    .sort();
}

function loadSkillDir(rootDir, source) {
  return skillDirs(rootDir).map((dir) => {
    const markdownPath = path.join(dir, MARKDOWN_SKILL_FILE_NAME);
    if (fs.existsSync(markdownPath)) {
      return readMarkdownSkill(markdownPath, source);
    }
    const filePath = path.join(dir, JSON_SKILL_FILE_NAME);
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

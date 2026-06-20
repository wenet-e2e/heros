import fs from 'node:fs';
import crypto from 'node:crypto';

const START = '<!-- HEROS_MEMORY_DATA_START -->';
const END = '<!-- HEROS_MEMORY_DATA_END -->';
const EMPTY_BLOCK = `${START}\n\`\`\`json\n[]\n\`\`\`\n${END}`;
const SECRET_PATTERN = /(api[_-]?key|token|password|secret|passwd|密钥|密码|令牌)/i;

function parseJsonBlock(markdown) {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }
  const block = markdown.slice(start + START.length, end);
  const match = block.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) {
    return [];
  }
  return JSON.parse(match[1]);
}

function replaceJsonBlock(markdown, memories) {
  const rendered = `${START}\n\`\`\`json\n${JSON.stringify(memories, null, 2)}\n\`\`\`\n${END}`;
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end <= start) {
    return `${markdown.trimEnd()}\n\n## Memory Data (managed by HerOS runtime)\n${rendered}\n`;
  }
  return `${markdown.slice(0, start)}${rendered}${markdown.slice(end + END.length)}`;
}

export class MemoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, `# MEMORY.md\n\n${EMPTY_BLOCK}\n`);
    }
  }

  list() {
    return parseJsonBlock(fs.readFileSync(this.filePath, 'utf8'));
  }

  write(memories) {
    const markdown = fs.readFileSync(this.filePath, 'utf8');
    fs.writeFileSync(this.filePath, replaceJsonBlock(markdown, memories));
  }

  create(content) {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Memory content is empty');
    }
    if (SECRET_PATTERN.test(trimmed)) {
      throw new Error('Refusing to store likely secret content in memory');
    }
    const now = new Date().toISOString();
    const memory = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      content: trimmed,
    };
    const memories = this.list();
    memories.push(memory);
    this.write(memories);
    return memory;
  }

  update(id, content) {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Memory content is empty');
    }
    if (SECRET_PATTERN.test(trimmed)) {
      throw new Error('Refusing to store likely secret content in memory');
    }
    const memories = this.list();
    const index = memories.findIndex((memory) => memory.id === id);
    if (index === -1) {
      return null;
    }
    memories[index] = {
      ...memories[index],
      content: trimmed,
      updatedAt: new Date().toISOString(),
    };
    this.write(memories);
    return memories[index];
  }

  delete(id) {
    const memories = this.list();
    const next = memories.filter((memory) => memory.id !== id);
    if (next.length === memories.length) {
      return false;
    }
    this.write(next);
    return true;
  }
}

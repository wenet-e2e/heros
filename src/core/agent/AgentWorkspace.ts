declare const require: ((name: string) => unknown) | undefined;

type RuntimeEnv = Record<string, string | undefined>;
declare const process: { env: RuntimeEnv };

export type AgentBootstrapFileName = "AGENTS.md" | "SOUL.md" | "MEMORY.md";

export interface AgentBootstrapFiles {
  AGENTS: string;
  SOUL: string;
  MEMORY: string;
}

export interface LongTermMemoryEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  content: string;
}

const WORKSPACE_ENV_KEY = "HEROS_AGENT_WORKSPACE_DIR";
const MEMORY_BLOCK_START = "<!-- HEROS_MEMORY_DATA_START -->";
const MEMORY_BLOCK_END = "<!-- HEROS_MEMORY_DATA_END -->";

const DEFAULT_TEMPLATES: Record<AgentBootstrapFileName, string> = {
  "AGENTS.md": `# AGENTS.md

## Mission
- HerOS is a voice-first assistant. Complete user intent safely and clearly.

## Priority Order
1. Safety and privacy
2. Correctness
3. User intent completion
4. Latency
5. Style

## Tool Policy
- Low-risk actions: execute directly.
- Medium-risk actions: ask for clarification when intent is ambiguous.
- High-risk actions (delete/send/pay/share): always ask for explicit confirmation.

## Privacy Rules
- Never expose private user data to third parties without explicit consent.
- Never write credentials, tokens, or secrets into memory files.

## Failure Policy
- If tool timeout occurs, explain briefly and offer retry.
- If intent confidence is low, ask one concise follow-up question.
- If uncertainty remains, choose conservative behavior.
`,
  "SOUL.md": `# SOUL.md

## Voice
- Warm, calm, concise.
- Avoid corporate filler and verbose framing.

## Response Style
- Lead with the direct answer.
- Keep spoken output short and easy to listen to.
- Add detail only when it improves execution quality.

## Personality
- Honest about uncertainty.
- Proactive but not pushy.
- Respectful and practical.

## Boundaries
- Never claim an action is done unless tools confirm it.
- Never fabricate facts or execution results.
`,
  "MEMORY.md": `# MEMORY.md

## Long-Term Memory Rules
- This file stores durable user memories for cross-session continuity.
- Every memory item must include id, createdAt, updatedAt, and content.
- Do not store secrets such as API keys, passwords, or private tokens.

## Memory Data (managed by HerOS)
${MEMORY_BLOCK_START}
\`\`\`json
[]
\`\`\`
${MEMORY_BLOCK_END}
`,
};

const BOOTSTRAP_FILE_LIST: AgentBootstrapFileName[] = ["AGENTS.md", "SOUL.md", "MEMORY.md"];

interface FileSystemAdapter {
  documentDirectoryPath: string;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

function createMemoryFileSystemAdapter(): FileSystemAdapter {
  const files = new Map<string, string>();
  return {
    documentDirectoryPath: "/memory/heros",
    async exists(path: string): Promise<boolean> {
      return files.has(path);
    },
    async mkdir(): Promise<void> {
      return;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async readFile(path: string): Promise<string> {
      return files.get(path) ?? "";
    },
  };
}

function createFileSystemAdapter(): FileSystemAdapter {
  try {
    if (typeof require !== "function") {
      return createMemoryFileSystemAdapter();
    }
    const loaded = require("react-native-fs") as
      | {
          default?: {
            DocumentDirectoryPath: string;
            exists(path: string): Promise<boolean>;
            mkdir(path: string): Promise<void>;
            writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
            readFile(path: string, encoding: "utf8"): Promise<string>;
          };
          DocumentDirectoryPath?: string;
          exists?: (path: string) => Promise<boolean>;
          mkdir?: (path: string) => Promise<void>;
          writeFile?: (path: string, content: string, encoding: "utf8") => Promise<void>;
          readFile?: (path: string, encoding: "utf8") => Promise<string>;
        }
      | undefined;
    const mod = loaded?.default ?? loaded;
    if (
      mod &&
      typeof mod.DocumentDirectoryPath === "string" &&
      typeof mod.exists === "function" &&
      typeof mod.mkdir === "function" &&
      typeof mod.writeFile === "function" &&
      typeof mod.readFile === "function"
    ) {
      return {
        documentDirectoryPath: mod.DocumentDirectoryPath,
        exists: (path: string) => mod.exists!(path),
        mkdir: (path: string) => mod.mkdir!(path),
        writeFile: (path: string, content: string, encoding: "utf8") => mod.writeFile!(path, content, encoding),
        readFile: (path: string, encoding: "utf8") => mod.readFile!(path, encoding),
      };
    }
    return createMemoryFileSystemAdapter();
  } catch {
    return createMemoryFileSystemAdapter();
  }
}

const fileSystem = createFileSystemAdapter();

function normalizeDirPath(dirPath: string): string {
  return dirPath.endsWith("/") ? dirPath.slice(0, -1) : dirPath;
}

function resolveAgentWorkspaceDir(): string {
  const override = process.env[WORKSPACE_ENV_KEY]?.trim();
  if (override) {
    return normalizeDirPath(override);
  }
  return normalizeDirPath(`${fileSystem.documentDirectoryPath}/agent-workspace`);
}

export class AgentWorkspace {
  private readonly workspaceDir = resolveAgentWorkspaceDir();
  private initPromise: Promise<void> | null = null;

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeInternal();
    }
    return this.initPromise;
  }

  async readBootstrapFiles(): Promise<AgentBootstrapFiles> {
    await this.ensureInitialized();
    const agents = await this.readNamedFile("AGENTS.md");
    const soul = await this.readNamedFile("SOUL.md");
    const memory = await this.readNamedFile("MEMORY.md");
    return {
      AGENTS: agents,
      SOUL: soul,
      MEMORY: memory,
    };
  }

  async buildBootstrapContextWindow(): Promise<string[]> {
    const files = await this.readBootstrapFiles();
    const sections: string[] = [];
    if (files.AGENTS.trim()) {
      sections.push(`[AGENTS]\n${files.AGENTS.trim()}`);
    }
    if (files.SOUL.trim()) {
      sections.push(`[SOUL]\n${files.SOUL.trim()}`);
    }
    if (files.MEMORY.trim()) {
      sections.push(`[MEMORY]\n${files.MEMORY.trim()}`);
    }
    return sections;
  }

  async readNamedFile(fileName: AgentBootstrapFileName): Promise<string> {
    await this.ensureInitialized();
    const filePath = this.resolveFilePath(fileName);
    return this.readUtf8(filePath);
  }

  async writeNamedFile(fileName: AgentBootstrapFileName, content: string): Promise<void> {
    await this.ensureInitialized();
    const filePath = this.resolveFilePath(fileName);
    await fileSystem.writeFile(filePath, content, "utf8");
  }

  async appendMemoryLine(line: string): Promise<void> {
    const content = normalizeMemoryContent(line);
    if (!content) return;
    await this.createLongTermMemory(content);
  }

  async listLongTermMemories(): Promise<LongTermMemoryEntry[]> {
    await this.ensureInitialized();
    const content = await this.readNamedFile("MEMORY.md");
    return this.parseMemoryEntries(content);
  }

  async getLongTermMemory(id: string): Promise<LongTermMemoryEntry | null> {
    const entries = await this.listLongTermMemories();
    return entries.find((item) => item.id === id) ?? null;
  }

  async createLongTermMemory(content: string): Promise<LongTermMemoryEntry> {
    const normalized = normalizeMemoryContent(content);
    if (!normalized) {
      throw new Error("memory content is empty");
    }
    const entries = await this.listLongTermMemories();
    const now = new Date().toISOString();
    const entry: LongTermMemoryEntry = {
      id: this.generateMemoryId(),
      createdAt: now,
      updatedAt: now,
      content: normalized,
    };
    entries.push(entry);
    await this.writeMemoryEntries(entries);
    return entry;
  }

  async updateLongTermMemory(id: string, content: string): Promise<LongTermMemoryEntry | null> {
    const normalized = normalizeMemoryContent(content);
    if (!normalized) {
      throw new Error("memory content is empty");
    }
    const entries = await this.listLongTermMemories();
    const target = entries.find((item) => item.id === id);
    if (!target) return null;
    target.content = normalized;
    target.updatedAt = new Date().toISOString();
    await this.writeMemoryEntries(entries);
    return target;
  }

  async deleteLongTermMemory(id: string): Promise<boolean> {
    const entries = await this.listLongTermMemories();
    const next = entries.filter((item) => item.id !== id);
    if (next.length === entries.length) {
      return false;
    }
    await this.writeMemoryEntries(next);
    return true;
  }

  async searchLongTermMemories(query: string, topK = 5): Promise<LongTermMemoryEntry[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];

    const queryTokens = this.tokenizeText(normalized);
    if (queryTokens.size === 0) return [];

    const entries = await this.listLongTermMemories();
    const scored: Array<{ entry: LongTermMemoryEntry; score: number }> = [];

    for (const entry of entries) {
      const tokens = this.tokenizeText(entry.content.toLowerCase());
      if (tokens.size === 0) continue;
      let overlap = 0;
      for (const token of queryTokens) {
        if (tokens.has(token)) {
          overlap += 1;
        }
      }
      if (overlap === 0) continue;
      const score = overlap / Math.max(queryTokens.size, 1);
      scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(20, topK))).map((item) => item.entry);
  }

  async readWorkspaceFile(
    relativePath: string,
    startLine?: number,
    endLine?: number
  ): Promise<{ ok: boolean; content?: string; error?: string }> {
    await this.ensureInitialized();
    const path = this.resolveWorkspacePath(relativePath);
    if (!path) return { ok: false, error: "invalid path" };
    const exists = await fileSystem.exists(path);
    if (!exists) return { ok: false, error: "file not found" };
    const raw = await this.readUtf8(path);
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, Number.isFinite(startLine) ? Number(startLine) : 1);
    const end = Math.min(lines.length, Number.isFinite(endLine) ? Number(endLine) : lines.length);
    if (end < start) {
      return { ok: true, content: "" };
    }
    const selected = lines.slice(start - 1, end);
    const numbered = selected.map((line, idx) => `${start + idx}|${line}`).join("\n");
    return { ok: true, content: numbered };
  }

  async writeWorkspaceFile(relativePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
    await this.ensureInitialized();
    const path = this.resolveWorkspacePath(relativePath);
    if (!path) return { ok: false, error: "invalid path" };
    const parent = this.parentDir(path);
    await fileSystem.mkdir(parent);
    await fileSystem.writeFile(path, content, "utf8");
    return { ok: true };
  }

  async editWorkspaceFile(
    relativePath: string,
    oldText: string,
    newText: string,
    replaceAll = false
  ): Promise<{ ok: boolean; error?: string; replaced?: number }> {
    await this.ensureInitialized();
    const path = this.resolveWorkspacePath(relativePath);
    if (!path) return { ok: false, error: "invalid path" };
    const exists = await fileSystem.exists(path);
    if (!exists) return { ok: false, error: "file not found" };
    const raw = await this.readUtf8(path);
    if (!oldText || !raw.includes(oldText)) {
      return { ok: false, error: "old_text not found" };
    }
    let replaced = 0;
    let next = raw;
    if (replaceAll) {
      replaced = raw.split(oldText).length - 1;
      next = raw.split(oldText).join(newText);
    } else {
      replaced = 1;
      next = raw.replace(oldText, newText);
    }
    await fileSystem.writeFile(path, next, "utf8");
    return { ok: true, replaced };
  }

  private async initializeInternal(): Promise<void> {
    await fileSystem.mkdir(this.workspaceDir);
    for (const fileName of BOOTSTRAP_FILE_LIST) {
      const targetPath = this.resolveFilePath(fileName);
      const exists = await fileSystem.exists(targetPath);
      if (!exists) {
        await fileSystem.writeFile(targetPath, DEFAULT_TEMPLATES[fileName], "utf8");
      }
    }
  }

  private resolveFilePath(fileName: AgentBootstrapFileName): string {
    return `${this.workspaceDir}/${fileName}`;
  }

  private resolveWorkspacePath(relativePath: string): string | null {
    const normalized = relativePath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!normalized) return null;
    if (normalized.startsWith("/")) return null;
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    if (segments.some((part) => part === "." || part === "..")) return null;
    return `${this.workspaceDir}/${segments.join("/")}`;
  }

  private parentDir(path: string): string {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return this.workspaceDir;
    return path.slice(0, idx);
  }

  private parseMemoryEntries(memoryMd: string): LongTermMemoryEntry[] {
    const block = this.extractMemoryDataBlock(memoryMd);
    if (!block) return [];
    try {
      const parsed = JSON.parse(block) as unknown;
      if (!Array.isArray(parsed)) return [];
      const entries: LongTermMemoryEntry[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === "string" ? rec.id.trim() : "";
        const createdAt = typeof rec.createdAt === "string" ? rec.createdAt.trim() : "";
        const updatedAt = typeof rec.updatedAt === "string" ? rec.updatedAt.trim() : "";
        const content = typeof rec.content === "string" ? rec.content.trim() : "";
        if (!id || !createdAt || !updatedAt || !content) continue;
        entries.push({ id, createdAt, updatedAt, content });
      }
      return entries;
    } catch {
      return [];
    }
  }

  private extractMemoryDataBlock(memoryMd: string): string | null {
    const start = memoryMd.indexOf(MEMORY_BLOCK_START);
    const end = memoryMd.indexOf(MEMORY_BLOCK_END);
    if (start < 0 || end < 0 || end <= start) return null;
    const body = memoryMd.slice(start + MEMORY_BLOCK_START.length, end);
    const jsonStart = body.indexOf("[");
    const jsonEnd = body.lastIndexOf("]");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
    return body.slice(jsonStart, jsonEnd + 1);
  }

  private async writeMemoryEntries(entries: LongTermMemoryEntry[]): Promise<void> {
    const filePath = this.resolveFilePath("MEMORY.md");
    const current = await this.readUtf8(filePath);
    const next = this.injectMemoryDataBlock(current, entries);
    await fileSystem.writeFile(filePath, next, "utf8");
  }

  private injectMemoryDataBlock(memoryMd: string, entries: LongTermMemoryEntry[]): string {
    const block = this.renderMemoryDataBlock(entries);
    const start = memoryMd.indexOf(MEMORY_BLOCK_START);
    const end = memoryMd.indexOf(MEMORY_BLOCK_END);
    if (start >= 0 && end > start) {
      const before = memoryMd.slice(0, start).replace(/\s*$/, "");
      const after = memoryMd.slice(end + MEMORY_BLOCK_END.length).replace(/^\s*/, "");
      return `${before}\n\n${block}${after ? `\n\n${after}` : ""}\n`;
    }
    const fallbackBase = memoryMd.trim() || DEFAULT_TEMPLATES["MEMORY.md"].trim();
    return `${fallbackBase}\n\n${block}\n`;
  }

  private renderMemoryDataBlock(entries: LongTermMemoryEntry[]): string {
    return [
      MEMORY_BLOCK_START,
      "```json",
      JSON.stringify(entries, null, 2),
      "```",
      MEMORY_BLOCK_END,
    ].join("\n");
  }

  private generateMemoryId(): string {
    const seed = Math.random().toString(36).slice(2, 8);
    return `mem_${Date.now().toString(36)}_${seed}`;
  }

  private tokenizeText(text: string): Set<string> {
    const matched = text.match(/[a-zA-Z0-9_]+|[\u4e00-\u9fff]/g) ?? [];
    return new Set(matched);
  }

  private async readUtf8(path: string): Promise<string> {
    try {
      return await fileSystem.readFile(path, "utf8");
    } catch {
      return "";
    }
  }
}

export const agentWorkspace = new AgentWorkspace();

function normalizeMemoryContent(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

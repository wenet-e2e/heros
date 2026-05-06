import { exec as execCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import sharedTooling from "../shared/SharedTooling.cjs";

const exec = promisify(execCb);

function readWithLineNumbers(fullPath, startLine, endLine) {
  const lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
  const start = Math.max(1, Number(startLine) || 1);
  const end = Math.min(lines.length, Number.isFinite(Number(endLine)) ? Number(endLine) : lines.length);
  if (end < start) return "";
  return lines
    .slice(start - 1, end)
    .map((line, idx) => `${start + idx}|${line}`)
    .join("\n");
}

function commandIsSafe(command) {
  const lowered = command.toLowerCase();
  const blockedPatterns = [
    /rm\s+-rf\s+\//,
    /mkfs/,
    /shutdown/,
    /reboot/,
    /:\(\)\s*\{\s*:\|\:&\s*\};:/,
    /\bdd\s+if=/,
    /sudo\s+/,
    /\bcurl\b.*\|\s*(bash|sh)/,
    /\bwget\b.*\|\s*(bash|sh)/,
  ];
  return !blockedPatterns.some((p) => p.test(lowered));
}

export class NodeAgentToolRuntime {
  constructor(workspaceDir) {
    this.workspaceDir = workspaceDir;
  }

  static schemas = sharedTooling.SHARED_TOOL_SCHEMAS;

  safeWorkspacePath(rawPath) {
    const cleaned = String(rawPath || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
    if (!cleaned || cleaned.startsWith("/")) return null;
    const parts = cleaned.split("/").filter(Boolean);
    if (!parts.length || parts.some((p) => p === "." || p === "..")) return null;
    return join(this.workspaceDir, parts.join("/"));
  }

  async runTool(toolName, rawArgs) {
    if (!this.sharedExecutor) {
      this.sharedExecutor = sharedTooling.buildSharedToolExecutor({
        file_read: async (args) => {
          const fullPath = this.safeWorkspacePath(args.path);
          if (!fullPath) return { ok: false, error: "invalid path" };
          if (!existsSync(fullPath)) return { ok: false, error: "file not found" };
          return { ok: true, payload: { content: readWithLineNumbers(fullPath, args.start_line, args.end_line) } };
        },
        file_write: async (args) => {
          const fullPath = this.safeWorkspacePath(args.path);
          if (!fullPath) return { ok: false, error: "invalid path" };
          mkdirSync(resolve(fullPath, ".."), { recursive: true });
          writeFileSync(fullPath, typeof args.content === "string" ? args.content : "", "utf8");
          return { ok: true, payload: { path: args.path } };
        },
        file_edit: async (args) => {
          const fullPath = this.safeWorkspacePath(args.path);
          if (!fullPath) return { ok: false, error: "invalid path" };
          if (!existsSync(fullPath)) return { ok: false, error: "file not found" };
          const oldText = typeof args.old_text === "string" ? args.old_text : "";
          const newText = typeof args.new_text === "string" ? args.new_text : "";
          if (!oldText) return { ok: false, error: "old_text is required" };
          const raw = readFileSync(fullPath, "utf8");
          if (!raw.includes(oldText)) return { ok: false, error: "old_text not found" };
          const replaceAll = Boolean(args.replace_all);
          const next = replaceAll ? raw.split(oldText).join(newText) : raw.replace(oldText, newText);
          const replaced = replaceAll ? raw.split(oldText).length - 1 : 1;
          writeFileSync(fullPath, next, "utf8");
          return { ok: true, payload: { path: args.path, replaced } };
        },
        memory_list: async () => {
          const memoryPath = join(this.workspaceDir, "MEMORY.md");
          const content = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
          return { ok: true, payload: { memories: content } };
        },
        memory_search: async (args) => {
          const query = String(args.query || "").trim().toLowerCase();
          if (!query) return { ok: false, error: "query is required" };
          const memoryPath = join(this.workspaceDir, "MEMORY.md");
          const content = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8").toLowerCase() : "";
          return { ok: true, payload: { hit: content.includes(query), query } };
        },
        system_exec: async (args) => {
          const command = String(args.command || "").trim();
          if (!command) return { ok: false, error: "command is required" };
          if (!commandIsSafe(command)) return { ok: false, error: "command blocked by policy" };
          const timeoutSec = Math.max(1, Math.min(30, Number(args.timeout_sec) || 10));
          try {
            const { stdout, stderr } = await exec(command, {
              cwd: process.cwd(),
              timeout: timeoutSec * 1000,
              maxBuffer: 1024 * 1024,
            });
            return {
              ok: true,
              payload: {
                exitCode: 0,
                stdout: String(stdout || "").slice(0, 4000),
                stderr: String(stderr || "").slice(0, 4000),
              },
            };
          } catch (error) {
            return {
              ok: true,
              payload: {
                exitCode: Number(error?.code || 1),
                stdout: String(error?.stdout || "").slice(0, 4000),
                stderr: String(error?.stderr || error?.message || "").slice(0, 4000),
              },
            };
          }
        },
      });
    }

    const result = await this.sharedExecutor(toolName, rawArgs);
    if (typeof result === "string") {
      return result;
    }
    return JSON.stringify({ ok: false, error: `unknown tool: ${toolName}` }, null, 2);
  }
}

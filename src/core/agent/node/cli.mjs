import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { DEFAULT_BASE_URL, DEFAULT_MAX_ROUNDS, DEFAULT_MODEL, normalize, readEnv } from "./env.mjs";
import { runAgentOnce } from "./runtime.mjs";
import { NodeAgentToolRuntime } from "./tool_runtime.mjs";

function ensureWorkspace(workspaceDir) {
  mkdirSync(workspaceDir, { recursive: true });
  const defaults = {
    "AGENTS.md": "# AGENTS.md\n\n- No session concept.\n- Use long-term memory only.\n",
    "SOUL.md": "# SOUL.md\n\n- Warm and concise.\n",
    "MEMORY.md":
      "# MEMORY.md\n\n<!-- HEROS_MEMORY_DATA_START -->\n```json\n[]\n```\n<!-- HEROS_MEMORY_DATA_END -->\n",
  };
  for (const [name, content] of Object.entries(defaults)) {
    const full = join(workspaceDir, name);
    if (!existsSync(full)) writeFileSync(full, content, "utf8");
  }
}

export async function runAgentTextCli(argv = process.argv.slice(2)) {
  const workspaceDir =
    normalize(readEnv("HEROS_AGENT_WORKSPACE_DIR")) || join(homedir(), ".heros", "agent-workspace");
  const model = readEnv("HEROS_LLM_MODEL", DEFAULT_MODEL);
  const baseUrl = readEnv("HEROS_LLM_BASE_URL", DEFAULT_BASE_URL);
  const apiKey = readEnv("HEROS_LLM_API_KEY");
  const maxRounds = Math.max(
    1,
    Math.min(12, Number(readEnv("HEROS_AGENT_MAX_TOOL_ROUNDS", String(DEFAULT_MAX_ROUNDS))))
  );

  ensureWorkspace(workspaceDir);
  const interactive = argv.includes("-i") || argv.includes("--interactive");
  const textArg = argv.filter((x) => x !== "-i" && x !== "--interactive").join(" ").trim();
  const toolRuntime = new NodeAgentToolRuntime(workspaceDir);

  console.log(`[agent-text] workspace: ${workspaceDir}`);
  console.log(`[agent-text] model: ${model}`);

  if (!interactive && !textArg) {
    console.log('用法: npm run agent:text -- "读取 MEMORY.md"');
    console.log("      npm run agent:text -- --interactive");
    return;
  }

  const runOnce = async (text) =>
    runAgentOnce({
      text,
      apiKey,
      model,
      baseUrl,
      maxRounds,
      toolSchemas: NodeAgentToolRuntime.schemas,
      runTool: (name, args) => toolRuntime.runTool(name, args),
    });

  if (interactive) {
    const rl = readline.createInterface({ input, output });
    console.log("[agent-text] interactive mode, 输入 exit 退出。");
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      const result = await runOnce(line);
      for (const t of result.toolCalls) {
        console.log(`[tool-call] ${t.tool}`);
        console.log(`  args: ${t.arguments}`);
        console.log(`  result: ${t.result.slice(0, 260)}`);
      }
      console.log(`[assistant] ${result.reply}`);
    }
    rl.close();
    return;
  }

  const result = await runOnce(textArg);
  for (const t of result.toolCalls) {
    console.log(`[tool-call] ${t.tool}`);
    console.log(`  args: ${t.arguments}`);
    console.log(`  result: ${t.result.slice(0, 260)}`);
  }
  console.log(`[assistant] ${result.reply}`);
}

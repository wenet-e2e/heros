import { agentWorkspace } from "./AgentWorkspace";
import { runSystemExec } from "./NativeShell";
declare const require: (name: string) => unknown;

const sharedTooling = require("./shared/SharedTooling.cjs") as {
  SHARED_TOOL_SCHEMAS: ToolSchema[];
  buildSharedToolExecutor: (handlers: Record<string, (args: Record<string, unknown>) => Promise<{
    ok: boolean;
    payload?: Record<string, unknown>;
    error?: string;
  }>>) => (toolName: string, rawArgs: string) => Promise<string | null>;
};

export interface AgentRuntimeOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxToolRounds?: number;
}

export interface AgentToolTrace {
  tool: string;
  arguments: string;
  result: string;
}

export interface AgentRunOptions {
  onToolTrace?: (trace: AgentToolTrace) => void;
}

export interface AgentRunResult {
  reply: string;
  toolTraces: AgentToolTrace[];
}

type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_MAX_TOOL_ROUNDS = 6;

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface ToolExecutionPayload {
  resultText: string;
}

class AgentToolRuntime {
  readonly schemas: ToolSchema[] = [
    ...sharedTooling.SHARED_TOOL_SCHEMAS,
    {
      type: "function",
      function: {
        name: "memory_get",
        description: "Get one memory by id.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_create",
        description: "Create a long-term memory item.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string" },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_update",
        description: "Update an existing memory item by id.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
          },
          required: ["id", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_delete",
        description: "Delete one memory item by id.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
  ];

  private readonly executeSharedTool = sharedTooling.buildSharedToolExecutor({
    file_read: async (args) => {
      const path = this.readString(args.path);
      if (!path) return { ok: false, error: "path is required" };
      const startLine = Number(args.start_line);
      const endLine = Number(args.end_line);
      const res = await agentWorkspace.readWorkspaceFile(
        path,
        Number.isFinite(startLine) ? startLine : undefined,
        Number.isFinite(endLine) ? endLine : undefined
      );
      if (!res.ok) return { ok: false, error: res.error ?? "read failed" };
      return { ok: true, payload: { content: res.content ?? "" } };
    },
    file_write: async (args) => {
      const path = this.readString(args.path);
      const content = typeof args.content === "string" ? args.content : "";
      if (!path) return { ok: false, error: "path is required" };
      const res = await agentWorkspace.writeWorkspaceFile(path, content);
      if (!res.ok) return { ok: false, error: res.error ?? "write failed" };
      return { ok: true, payload: { path } };
    },
    file_edit: async (args) => {
      const path = this.readString(args.path);
      const oldText = typeof args.old_text === "string" ? args.old_text : "";
      const newText = typeof args.new_text === "string" ? args.new_text : "";
      const replaceAll = Boolean(args.replace_all);
      if (!path || !oldText) return { ok: false, error: "path and old_text are required" };
      const res = await agentWorkspace.editWorkspaceFile(path, oldText, newText, replaceAll);
      if (!res.ok) return { ok: false, error: res.error ?? "edit failed" };
      return { ok: true, payload: { path, replaced: res.replaced ?? 0 } };
    },
    memory_list: async () => {
      const memories = await agentWorkspace.listLongTermMemories();
      return { ok: true, payload: { memories } };
    },
    memory_search: async (args) => {
      const query = this.readString(args.query);
      const topK = Number.isFinite(args.top_k) ? Number(args.top_k) : 5;
      if (!query) return { ok: false, error: "query is required" };
      const hits = await agentWorkspace.searchLongTermMemories(query, topK);
      return { ok: true, payload: { hits } };
    },
    system_exec: async (args) => {
      const command = this.readString(args.command);
      const timeoutSec = Number.isFinite(args.timeout_sec) ? Number(args.timeout_sec) : 10;
      const result = await runSystemExec(command, timeoutSec);
      if (!result.ok) return { ok: false, error: result.error ?? "system_exec failed" };
      return {
        ok: true,
        payload: {
          exitCode: result.exitCode ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        },
      };
    },
  });

  constructor() {}

  async execute(toolName: string, rawArgs: string): Promise<ToolExecutionPayload> {
    const sharedResult = await this.executeSharedTool(toolName, rawArgs);
    if (typeof sharedResult === "string") {
      return { resultText: sharedResult };
    }
    const args = this.parseArgs(rawArgs);
    if (toolName === "memory_get") {
      const id = this.readString(args.id);
      if (!id) return this.fail("id is required");
      const item = await agentWorkspace.getLongTermMemory(id);
      return this.ok({ item });
    }
    if (toolName === "memory_create") {
      const content = this.readString(args.content);
      if (!content) return this.fail("content is required");
      const item = await agentWorkspace.createLongTermMemory(content);
      return this.ok({ item });
    }
    if (toolName === "memory_update") {
      const id = this.readString(args.id);
      const content = this.readString(args.content);
      if (!id || !content) return this.fail("id and content are required");
      const item = await agentWorkspace.updateLongTermMemory(id, content);
      if (!item) return this.fail("memory not found");
      return this.ok({ item });
    }
    if (toolName === "memory_delete") {
      const id = this.readString(args.id);
      if (!id) return this.fail("id is required");
      const deleted = await agentWorkspace.deleteLongTermMemory(id);
      return this.ok({ deleted });
    }
    return this.fail(`unknown tool: ${toolName}`);
  }

  private parseArgs(rawArgs: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(rawArgs || "{}") as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private readString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private ok(payload: Record<string, unknown>): ToolExecutionPayload {
    return { resultText: JSON.stringify({ ok: true, ...payload }, null, 2) };
  }

  private fail(message: string): ToolExecutionPayload {
    return { resultText: JSON.stringify({ ok: false, error: message }, null, 2) };
  }
}

export class AgentRuntime {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly chatCompletionsUrl: string;
  private readonly maxToolRounds: number;
  private readonly toolRuntime: AgentToolRuntime;

  constructor(options: AgentRuntimeOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.chatCompletionsUrl = toChatCompletionsUrl(options.baseUrl);
    this.maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.toolRuntime = new AgentToolRuntime();
  }

  async run(inputText: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const cleanInput = inputText.trim();
    if (!cleanInput) {
      return {
        reply: "我没有听清，你可以再说一遍。",
        toolTraces: [],
      };
    }

    if (!this.apiKey) {
      return this.ruleBasedFallback(cleanInput);
    }

    await agentWorkspace.ensureInitialized();
    const bootstrap = await agentWorkspace.readBootstrapFiles();

    const messages: ChatCompletionMessage[] = [
      {
        role: "system",
        content:
          "你是 HerOS Agent Runtime。你可以调用工具完成长期记忆管理和工作区文件读写。" +
          "你可以通过 file_read/file_write/file_edit 操作 MEMORY.md 来管理记忆。" +
          "在桌面端可用时，也可以通过 system_exec 执行受限诊断命令。" +
          "系统不使用 session 概念，也不允许 session 级记忆，只使用长期 MEMORY。" +
          "优先调用工具得到真实结果，再给用户简洁回答。",
      },
      { role: "system", content: `[AGENTS]\n${bootstrap.AGENTS}` },
      { role: "system", content: `[SOUL]\n${bootstrap.SOUL}` },
      { role: "system", content: `[MEMORY]\n${bootstrap.MEMORY}` },
      { role: "user", content: cleanInput },
    ];

    const traces: AgentToolTrace[] = [];
    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const response = await fetch(this.chatCompletionsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: this.toolRuntime.schemas,
          tool_choice: "auto",
        }),
      });

      if (!response.ok) {
        return this.ruleBasedFallback(cleanInput);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      const message = (choice as { message?: Record<string, unknown> } | null)?.message;
      if (!message || typeof message !== "object") {
        return this.ruleBasedFallback(cleanInput);
      }

      const toolCalls = Array.isArray(message.tool_calls)
        ? (message.tool_calls as Array<Record<string, unknown>>)
        : [];

      if (toolCalls.length === 0) {
        const finalReply =
          typeof message.content === "string" && message.content.trim()
            ? message.content.trim()
            : "好的，我已经处理完成。";
        return { reply: finalReply, toolTraces: traces };
      }

      messages.push({
        ...message,
        role: "assistant",
        content: typeof message.content === "string" ? message.content : "",
        tool_calls: toolCalls.map((tool) => {
          const fn = (tool.function as Record<string, unknown>) ?? {};
          return {
            id: typeof tool.id === "string" ? tool.id : this.generateToolCallId(),
            type: "function" as const,
            function: {
              name: typeof fn.name === "string" ? fn.name : "",
              arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
            },
          };
        }),
      });

      for (const tool of toolCalls) {
        const fn = (tool.function as Record<string, unknown>) ?? {};
        const name = typeof fn.name === "string" ? fn.name : "";
        const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "{}";
        const callId = typeof tool.id === "string" ? tool.id : this.generateToolCallId();
        const executed = await this.toolRuntime.execute(name, rawArgs);
        const trace: AgentToolTrace = {
          tool: name,
          arguments: rawArgs,
          result: executed.resultText,
        };
        traces.push(trace);
        options.onToolTrace?.(trace);
        messages.push({
          role: "tool",
          tool_call_id: callId,
          name,
          content: executed.resultText,
        });
      }
    }

    return {
      reply: "本轮工具调用过多，我先暂停并等待你下一步指令。",
      toolTraces: traces,
    };
  }

  private async ruleBasedFallback(inputText: string): Promise<AgentRunResult> {
    if (/记住|长期记忆|记下来/.test(inputText)) {
      const content = inputText.replace(/^.*?(记住|长期记忆|记下来)\s*/u, "").trim();
      if (content) {
        await this.toolRuntime.execute("memory_create", JSON.stringify({ content }));
        return { reply: "好的，我已经记住这条长期信息。", toolTraces: [] };
      }
    }

    return {
      reply: "我可以管理长期记忆，或通过文件工具读写工作区文件（包括 MEMORY.md）。",
      toolTraces: [],
    };
  }

  private generateToolCallId(): string {
    return `call_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toChatCompletionsUrl(baseUrl?: string): string {
  const raw = (baseUrl || "https://api.openai.com/v1/responses").trim();
  if (raw.endsWith("/chat/completions")) return raw;
  if (raw.endsWith("/responses")) return `${raw.slice(0, -"/responses".length)}/chat/completions`;
  if (raw.endsWith("/v1")) return `${raw}/chat/completions`;
  if (raw.endsWith("/v1/")) return `${raw}chat/completions`;
  return `${raw.replace(/\/+$/, "")}/chat/completions`;
}

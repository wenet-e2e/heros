const SHARED_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read a workspace file with optional line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "number" },
          end_line: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Create or overwrite a workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_edit",
      description: "Replace text in a workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_list",
      description: "List all long-term memories.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Search memories by keyword overlap.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          top_k: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_exec",
      description: "Execute a safe shell command for diagnostics on desktop.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_sec: { type: "number" },
        },
        required: ["command"],
      },
    },
  },
];

function parseArgs(rawArgs) {
  try {
    const parsed = JSON.parse(rawArgs || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function ok(payload) {
  return JSON.stringify({ ok: true, ...(payload || {}) }, null, 2);
}

function fail(error) {
  return JSON.stringify({ ok: false, error }, null, 2);
}

function buildSharedToolExecutor(handlers) {
  return async function executeSharedTool(toolName, rawArgs) {
    const handler = handlers[toolName];
    if (typeof handler !== "function") {
      return null;
    }
    const args = parseArgs(rawArgs);
    try {
      const result = await handler(args);
      if (result && result.ok === false) {
        return fail(result.error || "tool failed");
      }
      return ok(result?.payload || {});
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}

module.exports = {
  SHARED_TOOL_SCHEMAS,
  buildSharedToolExecutor,
};

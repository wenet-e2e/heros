import { toChatCompletionsUrl } from "./env.mjs";

export async function runAgentOnce({
  text,
  apiKey,
  model,
  baseUrl,
  maxRounds,
  toolSchemas,
  runTool,
}) {
  if (!apiKey) return { reply: "HEROS_LLM_API_KEY 未设置。", toolCalls: [] };

  const url = toChatCompletionsUrl(baseUrl);
  const messages = [
    {
      role: "system",
      content:
        "You are HerOS Agent Runtime. No session concept. " +
        "Use tools file_read/file_write/file_edit and system_exec. " +
        "Long-term memory is managed by editing MEMORY.md.",
    },
    { role: "user", content: String(text || "").trim() },
  ];

  const toolCalls = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: toolSchemas,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { reply: `LLM 请求失败: ${response.status} ${body.slice(0, 300)}`, toolCalls };
    }

    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      return { reply: String(message?.content || "done"), toolCalls };
    }

    messages.push({
      ...message,
      role: "assistant",
      content: typeof message?.content === "string" ? message.content : "",
    });

    for (const call of calls) {
      const name = call?.function?.name || "";
      const args = typeof call?.function?.arguments === "string" ? call.function.arguments : "{}";
      const result = await runTool(name, args);
      toolCalls.push({ tool: name, arguments: args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id || `call_${Math.random().toString(36).slice(2, 8)}`,
        name,
        content: result,
      });
    }
  }

  return { reply: "工具调用超过上限，请重试。", toolCalls };
}

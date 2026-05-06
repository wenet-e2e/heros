import {
  isDangerousOperationInput,
  isEmptyLikeInput,
  isExplicitChitchatInput,
  isExplicitCommandInput,
} from "./IntentLexicon";

export type IntentLabel = "chitchat" | "intent";

export interface IntentClassificationResult {
  label: IntentLabel;
  confidence: number;
  reason: string;
  intentHint?: string;
}

export interface IntentClassifier {
  classify(text: string, conversationWindow?: string[]): Promise<IntentClassificationResult>;
}

export interface LLMIntentClassifierOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1/responses";
const DEFAULT_TIMEOUT_MS = 3000;

function clampConfidence(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function heuristicClassify(text: string): IntentClassificationResult {
  const source = text.trim();
  if (isEmptyLikeInput(source)) {
    return { label: "chitchat", confidence: 0.99, reason: "空输入。" };
  }

  if (isExplicitChitchatInput(source)) {
    return {
      label: "chitchat",
      confidence: 0.95,
      reason: "命中明确闲聊/寒暄短句，按 chitchat 处理。",
    };
  }

  if (isDangerousOperationInput(source)) {
    return {
      label: "intent",
      confidence: 0.92,
      reason: "命中高风险操作关键词，需进入执行链路并触发确认。",
    };
  }

  if (isExplicitCommandInput(source)) {
    return {
      label: "intent",
      confidence: 0.82,
      reason: "命中动作/时间/执行关键词。",
    };
  }
  return {
    label: "intent",
    confidence: 0.68,
    reason: "默认策略偏向 Agent：除非是明确闲聊，否则按 intent 处理。",
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseResponsesOutput(data: Record<string, unknown>): Record<string, unknown> | null {
  const outputText = data.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return extractJsonObject(outputText);
  }

  const output = data.output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const blockText = (block as { text?: unknown }).text;
      if (typeof blockText === "string" && blockText.trim()) {
        const parsed = extractJsonObject(blockText);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

export class LLMIntentClassifier implements IntentClassifier {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: LLMIntentClassifierOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(text: string, conversationWindow: string[] = []): Promise<IntentClassificationResult> {
    if (!this.apiKey) {
      return heuristicClassify(text);
    }

    const context = conversationWindow.slice(-4).map((item, idx) => `${idx + 1}. ${item}`).join("\n");
    const userPayload = [
      `当前输入: ${text}`,
      context ? `最近上下文:\n${context}` : "最近上下文: 无",
      "请返回 JSON。",
    ].join("\n\n");

    const body = {
      model: this.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "你是 HerOS 的意图路由分类器，只输出 'chitchat' 或 'intent'。" +
                "路由策略：默认偏向 intent，只有在“非常明确且纯粹的闲聊/寒暄”时才输出 chitchat。" +
                "凡是用户在请求你做事、查询信息、解释设备状态、查看系统信息、读取或修改内容，都应该是 intent。" +
                "例如：'我的电脑内存多大'、'今天天气怎么样'、'帮我看一下...'、'查一下...' 都是 intent。" +
                "例如：'你好'、'谢谢'、'晚安' 这类纯寒暄才是 chitchat。" +
                "必须输出 JSON，字段: label, confidence, reason, intentHint。",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userPayload }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "intent_classification",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["label", "confidence", "reason", "intentHint"],
            properties: {
              label: { type: "string", enum: ["chitchat", "intent"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string" },
              intentHint: { type: "string" },
            },
          },
          strict: true,
        },
      },
      max_output_tokens: 120,
    };

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => {
          controller.abort();
        }, this.timeoutMs)
      : null;

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });

      if (!response.ok) {
        return heuristicClassify(text);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const parsed = parseResponsesOutput(data);
      if (!parsed) {
        return heuristicClassify(text);
      }

      const label = parsed.label === "intent" ? "intent" : "chitchat";
      const confidence = clampConfidence(Number(parsed.confidence));
      const reason = typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason
        : "LLM 未返回有效原因，使用默认说明。";
      const intentHint = typeof parsed.intentHint === "string" ? parsed.intentHint : undefined;

      return {
        label,
        confidence,
        reason,
        intentHint,
      };
    } catch {
      return heuristicClassify(text);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

const SYSTEM_PROMPT_SHORT =
  "你是意图路由器。只输出 JSON：{\"label\":\"chitchat\"|\"intent\",\"confidence\":0-1,\"reason\":\"原因\"}。" +
  "闲聊/寒暄/问候/感叹=chitchat。请求做事/查询/操作/执行=intent。默认偏向intent。";

export class ChatCompletionsIntentClassifier implements IntentClassifier {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: LLMIntentClassifierOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(text: string): Promise<IntentClassificationResult> {
    if (!this.apiKey) {
      return heuristicClassify(text);
    }

    const url = this.baseUrl.endsWith("/chat/completions")
      ? this.baseUrl
      : `${this.baseUrl}/chat/completions`;

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT_SHORT },
            { role: "user", content: text },
          ],
          max_tokens: 150,
          temperature: 0,
        }),
        signal: controller?.signal,
      });

      if (!response.ok) {
        return heuristicClassify(text);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const content =
        (data?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content || "";
      const json = JSON.parse(content.trim()) as Record<string, unknown>;

      const label = json.label === "intent" ? "intent" : "chitchat";
      const confidence = clampConfidence(Number(json.confidence));
      const reason =
        typeof json.reason === "string" && json.reason.trim() ? json.reason : "ChatCompletions 分类";

      return { label, confidence, reason };
    } catch {
      return heuristicClassify(text);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}


#!/usr/bin/env npx tsx

/**
 * 完整流水线终端测试（共享 src 模块）
 *
 * 文本输入 → IntentClassifier → 分流：
 *   chitchat → Doubao 端到端语音回复
 *   intent   → Agent 执行任务 → Doubao TTS 语音回复
 *
 * 用法：
 *   npx tsx scripts/test_pipeline.ts -- "你好"
 *   npm run test:pipeline -- "帮我查一下内存"
 *   npm run test:pipeline -- --interactive
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { homedir } from "node:os";

// 共享模块 — 意图分类
import {
  LLMIntentClassifier,
  ChatCompletionsIntentClassifier,
  type IntentClassificationResult,
  type IntentClassifier,
} from "../src/core/agent/IntentClassifier";

// 共享模块 — Doubao 协议与会话
import { DoubaoSession, type DoubaoSessionConfig } from "../src/core/voice/DoubaoSession";
import {
  parseDoubaoResponse,
  type DoubaoParsedResponse,
} from "../src/core/voice/doubaoProtocol";

// 共享模块 — 音频
import {
  isSoxAvailable,
  createAudioPlayer,
  writeToPlayer,
  stopPlayer,
} from "../src/core/voice/audioUtils.mjs";

// ═══════════════════════════════════════════
// 环境变量
// ═══════════════════════════════════════════

function loadEnvFile(pathname: string): Record<string, string> {
  if (!existsSync(pathname)) return {};
  const text = readFileSync(pathname, "utf8");
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
    if (!env[key]) env[key] = value;
  }
  return env;
}

const localEnv = loadEnvFile(resolve(process.cwd(), ".env.local"));

function getEnv(name: string, fallback = ""): string {
  if (process.env[name]) return process.env[name];
  if (localEnv[name]) return localEnv[name];
  return fallback;
}

function loadDoubaoConfig(): DoubaoSessionConfig | null {
  const appId = getEnv("HEROS_DOUBAO_APP_ID");
  const accessKey = getEnv("HEROS_DOUBAO_ACCESS_KEY");
  if (!appId || !accessKey) return null;
  return {
    baseUrl: getEnv("HEROS_DOUBAO_BASE_URL", "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"),
    appId,
    accessKey,
    resourceId: getEnv("HEROS_DOUBAO_RESOURCE_ID", "volc.speech.dialog"),
    appKey: getEnv("HEROS_DOUBAO_APP_KEY", "PlgvMymc7f3tQnJ6"),
    speaker: getEnv("HEROS_DOUBAO_SPEAKER", "zh_female_xiaohe_jupiter_bigtts"),
    botName: getEnv("HEROS_DOUBAO_BOT_NAME", "豆包"),
    systemRole: getEnv("HEROS_DOUBAO_SYSTEM_ROLE", "你使用活泼灵动的女声，性格开朗，热爱生活。"),
    speakingStyle: getEnv("HEROS_DOUBAO_SPEAKING_STYLE", "你的说话风格简洁明了，语速适中，语调自然。"),
    greeting: getEnv("HEROS_DOUBAO_GREETING", "你好"),
    recvTimeout: 120,
    outputFormat: "pcm_s16le",
    inputMod: "text",
  };
}

function loadClassifierConfig() {
  const apiKey = getEnv("HEROS_LLM_API_KEY");
  return {
    apiKey: apiKey || undefined,
    model: getEnv("HEROS_LLM_MODEL", "gpt-4.1-mini"),
    baseUrl: getEnv("HEROS_LLM_BASE_URL", "https://api.openai.com/v1/responses"),
    timeoutMs: 3000,
  };
}

function loadAgentConfig() {
  const apiKey = getEnv("HEROS_LLM_API_KEY");
  if (!apiKey) return null;
  return {
    apiKey,
    model: getEnv("HEROS_LLM_MODEL", "gpt-4.1-mini"),
    baseUrl: getEnv("HEROS_LLM_BASE_URL", "https://api.openai.com/v1"),
    maxRounds: 6,
  };
}

// ═══════════════════════════════════════════
// Agent 调用
// ═══════════════════════════════════════════

async function runLLMAgent(text: string, agentConfig: ReturnType<typeof loadAgentConfig>): Promise<string> {
  if (!agentConfig) return "HEROS_LLM_API_KEY 未设置，无法使用 Agent。";

  const { apiKey, model, baseUrl, maxRounds } = agentConfig;
  const { NodeAgentToolRuntime } = await import("../src/core/agent/node/tool_runtime.mjs");
  const { runAgentOnce } = await import("../src/core/agent/node/runtime.mjs");

  const workspaceDir = getEnv("HEROS_AGENT_WORKSPACE_DIR")
    || resolve(homedir(), ".heros", "agent-workspace");
  mkdirSync(workspaceDir, { recursive: true });

  const toolRuntime = new NodeAgentToolRuntime(workspaceDir);
  const result = await runAgentOnce({
    text,
    apiKey,
    model,
    baseUrl,
    maxRounds,
    toolSchemas: NodeAgentToolRuntime.schemas,
    runTool: (name: string, args: string) => toolRuntime.runTool(name, args),
  });

  for (const t of result.toolCalls) {
    console.log(`  [tool] ${t.tool}(${(t.arguments || "").slice(0, 80)}) → ${(t.result || "").slice(0, 120)}`);
  }
  return result.reply;
}

// ═══════════════════════════════════════════
// Doubao 语音回复（chitchat 路径）
// ═══════════════════════════════════════════

function deepFindText(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() ? payload : null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const text = deepFindText(item);
      if (text) return text;
    }
    return null;
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["asr_text", "text", "content", "answer", "query", "question"]) {
      const text = deepFindText(obj[key]);
      if (text) return text;
    }
    for (const val of Object.values(obj)) {
      const text = deepFindText(val);
      if (text) return text;
    }
  }
  return null;
}

function shouldDisplayText(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  if (/^\d{12,}$/.test(t)) return false; // isLikelyNoise (long digit strings)
  if (/^[0-9a-f]{8}-[0-9a-f-]+$/i.test(t)) return false; // UUID-like
  if (/^[\d]+$/.test(t)) return false; // pure digits
  if (t === "v3") return false; // Doubao version marker
  return true;
}

async function doubaoChitchatReply(
  userText: string,
  doubaoConfig: DoubaoSessionConfig,
): Promise<string> {
  const session = new DoubaoSession(doubaoConfig);
  const player = createAudioPlayer();

  if (player) {
    console.log("  [audio] SoX 播放就绪");
  } else {
    console.log("  [audio] SoX 不可用，仅显示文本");
  }

  let replyText = "";
  let greetingDone = false;

  return new Promise((resolve, reject) => {
    session.connect().then(() => {
      session.ws!.on("message", (raw: Buffer | ArrayBuffer) => {
        const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const parsed = parseDoubaoResponse(data);
        if (!parsed) return;

        if (parsed.messageType === "SERVER_ERROR") {
          console.error("  [doubao] 错误:", parsed.code);
          return;
        }

        if (session.phase === "waiting_start_connection") {
          session.phase = "waiting_start_session";
          session.sendStartSession();
          return;
        }

        if (session.phase === "waiting_start_session") {
          session.phase = "ready";
          session.resolveReady!();
          console.log(`  [doubao] 发送 SayHello: "${doubaoConfig.greeting}"`);
          session.sendSayHello();
          return;
        }

        // Phase 1: Greeting TTS
        if (!greetingDone) {
          if (parsed.event === 359) {
            greetingDone = true;
            console.log(`  [doubao] Greeting 完成，发送查询: "${userText}"`);
            session.sendTextQuery(userText);
          }
          return;
        }

        // Phase 2: Query response
        const text = deepFindText(parsed.payload);
        if (text && shouldDisplayText(text) && !replyText.includes(text)) {
          replyText += text;
          console.log(`  [doubao] 回复: ${text}`);
        }

        if (parsed.messageType === "SERVER_ACK" && parsed.payloadRaw?.length) {
          writeToPlayer(player, parsed.payloadRaw);
        }

        if (parsed.event === 359 || parsed.event === 152 || parsed.event === 153) {
          setTimeout(async () => {
            stopPlayer(player);
            await session.shutdown();
            resolve(replyText || "(无文本回复)");
          }, 2000);
        }
      });

      session.ws!.on("error", (err: Error) => reject(err));
    }).catch(reject);
  });
}

// ═══════════════════════════════════════════
// Doubao TTS 语音合成（intent 路径）
// ═══════════════════════════════════════════

async function doubaoTtsReply(
  agentReplyText: string,
  doubaoConfig: DoubaoSessionConfig,
): Promise<void> {
  const session = new DoubaoSession({ ...doubaoConfig, inputMod: "audio" });
  const player = createAudioPlayer();

  if (!player) {
    console.log("  [audio] SoX 不可用，跳过语音播报");
    return;
  }

  console.log("  [audio] SoX 播放就绪");

  return new Promise((resolve, reject) => {
    const TTS_TIMEOUT_MS = 60000;
    let phase: "greeting" | "sending_audio" | "waiting_tts" = "greeting";
    let chatTtsAudio = false;
    let ttsTextReceived = false;

    const timeout = setTimeout(() => {
      console.log("  [tts] 超时 (60s)，强制结束");
      stopPlayer(player);
      session.shutdown().catch(() => {});
      resolve();
    }, TTS_TIMEOUT_MS);

    const cleanup = async () => {
      clearTimeout(timeout);
      stopPlayer(player);
      await session.shutdown();
      resolve();
    };

    // Load trigger audio (whoareyou.wav)
    const wavBuf = readFileSync(resolve(process.cwd(), "whoareyou.wav"));
    const audioBuf = wavBuf.slice(44); // strip WAV header
    const silenceBuf = Buffer.alloc(32000); // 1s silence for VAD
    const fullAudio = Buffer.concat([audioBuf, silenceBuf]);
    const CHUNK_BYTES = 3200;

    session.connect().then(() => {
      session.ws!.on("message", (raw: Buffer | ArrayBuffer) => {
        try {
          const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          const parsed = parseDoubaoResponse(data);
          if (!parsed) return;

          if (parsed.messageType === "SERVER_ERROR") {
            console.error("  [doubao] 错误:", parsed.code, JSON.stringify(parsed.payload));
            return;
          }

          if (session.phase === "waiting_start_connection") {
            session.phase = "waiting_start_session";
            session.sendStartSession();
            return;
          }

          if (session.phase === "waiting_start_session") {
            session.phase = "ready";
            session.resolveReady!();
            console.log(`  [doubao] 发送 SayHello: "${doubaoConfig.greeting}"`);
            session.sendSayHello();
            return;
          }

          // Phase 1: Wait for greeting TTS, then send trigger audio
          if (phase === "greeting") {
            if (parsed.event === 359) {
              console.log("  [doubao] Greeting TTS 完成，发送触发音频...");
              phase = "sending_audio";
              let sentBytes = 0;
              const audioInterval = setInterval(() => {
                if (phase !== "sending_audio" || session.closed) {
                  clearInterval(audioInterval);
                  return;
                }
                const end = Math.min(sentBytes + CHUNK_BYTES, fullAudio.length);
                if (sentBytes >= fullAudio.length) {
                  clearInterval(audioInterval);
                  return;
                }
                session.sendAudioChunk(fullAudio.slice(sentBytes, end));
                sentBytes = end;
              }, 100);
            }
            return;
          }

          // Phase 2: Wait for ASR_ENDED, then send ChatTtsText
          if (phase === "sending_audio") {
            if (parsed.messageType === "SERVER_ACK" && parsed.payloadRaw?.length) {
              return; // ignore audio during ASR phase
            }
            if (parsed.event === 459) {
              console.log("  [doubao] ASR_ENDED，发送 ChatTtsText");
              const preview = agentReplyText.slice(0, 60) + (agentReplyText.length > 60 ? "..." : "");
              console.log(`  [doubao] ChatTtsText: "${preview}"`);
              session.sendChatTtsText(agentReplyText);
              phase = "waiting_tts";
            }
            return;
          }

          // Phase 3: Collect ChatTtsText TTS audio (skip default response audio)
          // Only play audio when tts_type=chat_tts_text
          if (parsed.messageType === "SERVER_ACK" && parsed.payloadRaw?.length) {
            if (chatTtsAudio) {
              writeToPlayer(player, parsed.payloadRaw);
              ttsTextReceived = true;
            }
            return;
          }

          if (parsed.event === 350) {
            const ttsType = (parsed.payload as Record<string, unknown>)?.tts_type ?? "unknown";
            if (ttsType === "chat_tts_text") {
              chatTtsAudio = true;
            }
            return;
          }

          if (parsed.event === 359 && chatTtsAudio) {
            console.log("  [doubao] ChatTtsText TTS 完成");
            setTimeout(cleanup, ttsTextReceived ? 1500 : 100);
          }
        } catch {
          // ignore parse errors
        }
      });

      session.ws!.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      session.ws!.on("close", () => {
        clearTimeout(timeout);
        stopPlayer(player);
        resolve();
      });
    }).catch((err: Error) => {
      console.error("  [doubao] 连接失败:", err.message);
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ═══════════════════════════════════════════
// 意图分类器工厂
// ═══════════════════════════════════════════

function isOpenAIResponsesEndpoint(baseUrl: string): boolean {
  return baseUrl.includes("/v1/responses") || baseUrl.includes("api.openai.com");
}

function createClassifier(config: ReturnType<typeof loadClassifierConfig>): IntentClassifier {
  if (isOpenAIResponsesEndpoint(config.baseUrl)) {
    return new LLMIntentClassifier(config);
  }
  return new ChatCompletionsIntentClassifier(config);
}


// ═══════════════════════════════════════════
// 主流水线
// ═══════════════════════════════════════════

async function runPipeline(
  userText: string,
  doubaoConfig: DoubaoSessionConfig | null,
  agentConfig: ReturnType<typeof loadAgentConfig>,
  classifierConfig: ReturnType<typeof loadClassifierConfig>,
) {
  console.log("═".repeat(50));
  console.log(`  输入: "${userText}"`);

  // Step 1: 意图分类
  const classifier = createClassifier(classifierConfig);
  const result = await classifier.classify(userText);
  // LLM reasons are natural language; heuristic reasons contain fixed Chinese phrases
  const isHeuristic = result.reason.includes("命中") || result.reason.includes("默认策略") ||
    result.reason.includes("空输入");
  const method = isHeuristic ? "启发式" : "LLM";
  console.log(`  方法: ${method}`);
  console.log(`  分类: ${result.label} (confidence=${result.confidence})`);
  console.log(`  原因: ${result.reason}`);

  // Step 2: 分流
  if (result.label === "chitchat") {
    console.log("  路由: → Doubao 端到端语音回复");
    console.log("═".repeat(50));

    if (doubaoConfig) {
      await doubaoChitchatReply(userText, doubaoConfig);
    } else {
      console.log("  (无 Doubao 鉴权，仅显示分类结果)");
    }
  } else {
    console.log("  路由: → Agent 任务执行");
    console.log("═".repeat(50));

    console.log("  [agent] 正在执行任务...");
    const agentReply = await runLLMAgent(userText, agentConfig);
    console.log(`  [agent] 回复: ${agentReply}`);

    if (doubaoConfig) {
      console.log("  [tts] 正在合成语音...");
      await doubaoTtsReply(agentReply, doubaoConfig);
    } else {
      console.log("  (无 Doubao 鉴权，仅显示 Agent 文本结果)");
    }
  }

  console.log("═".repeat(50));
  console.log("  完成\n");
}

// ═══════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════

async function main() {
  const argv = process.argv.slice(2);
  const interactive = argv.includes("-i") || argv.includes("--interactive");
  const textArg = argv.filter((x) => x !== "-i" && x !== "--interactive").join(" ").trim();

  const doubaoConfig = loadDoubaoConfig();
  const agentConfig = loadAgentConfig();
  const classifierConfig = loadClassifierConfig();

  console.log("═══════════════════════════════════════");
  console.log("  HerOS 完整流水线测试 (共享模块)");
  console.log("═══════════════════════════════════════");
  console.log(`  Doubao: ${doubaoConfig ? "已配置" : "未配置"}`);
  console.log(`  Agent:  ${agentConfig ? `已配置 (${agentConfig.model})` : "未配置"}`);
  console.log(`  分类器: ${classifierConfig.apiKey ? "LLM" : "启发式"}`);
  console.log(`  音频:   ${isSoxAvailable() ? "SoX 可用" : "SoX 不可用"}`);
  console.log("");

  if (!interactive && !textArg) {
    console.log('用法: npx tsx scripts/test_pipeline.ts -- "你好"');
    console.log("      npx tsx scripts/test_pipeline.ts -- --interactive");
    return;
  }

  if (interactive) {
    const rl = createInterface({ input, output });
    console.log("[pipeline] 交互模式，输入文本后回车。输入 exit 退出。\n");
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      await runPipeline(line, doubaoConfig, agentConfig, classifierConfig);
    }
    rl.close();
    return;
  }

  await runPipeline(textArg, doubaoConfig, agentConfig, classifierConfig);
}

main().catch((e) => {
  console.error("[pipeline] 错误:", e.message);
  process.exit(1);
});

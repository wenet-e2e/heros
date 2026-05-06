#!/usr/bin/env node

/**
 * 豆包端到端语音 CLI 工具
 *
 * 三种模式：
 *   audio (默认):  麦克风 → 实时 ASR + TTS
 *   text:          stdin 输入 → ChatTextQuery → TTS/文本输出
 *   audio file:    音频文件 → 服务端处理 → 保存 PCM 文件
 *
 * 用法：
 *   npm run doubao                          # 音频模式
 *   npm run doubao:text -- "你好"            # 文本模式
 *   npm run doubao:file -- --audio=foo.wav  # 音频文件模式
 */

import { readFileSync, existsSync, createWriteStream, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import WebSocket from "ws";

// ── 常量 ──

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;

const CLIENT_FULL_REQUEST = 0b0001;
const CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const SERVER_FULL_RESPONSE = 0b1001;
const SERVER_ACK = 0b1011;
const SERVER_ERROR_RESPONSE = 0b1111;

const MSG_WITH_EVENT = 0b0100;
const NO_SERIALIZATION = 0b0000;
const JSON_SERIALIZATION = 0b0001;
const NO_COMPRESSION = 0b0000;
const GZIP_COMPRESSION = 0b0001;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// 音频参数（从共享模块导入，不再重复定义）
// INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, INPUT_CHUNK_FRAMES 从 audioUtils.mjs 导入

// ── 环境变量加载 ──

function loadEnvFile(pathname) {
  if (!existsSync(pathname)) return {};
  const text = readFileSync(pathname, "utf8");
  const env = {};
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

function getEnv(name, fallback = "") {
  if (process.env[name]) return process.env[name];
  if (localEnv[name]) return localEnv[name];
  return fallback;
}

// ── CLI 参数解析 ──

function parseArgs() {
  const args = {
    mod: "audio",
    audio: null,
    format: "pcm_s16le",
    recvTimeout: null,
    speaker: getEnv("HEROS_DOUBAO_SPEAKER", "zh_female_xiaohe_jupiter_bigtts"),
    greeting: getEnv("HEROS_DOUBAO_GREETING", "你好"),
    output: null,
    textInput: "",
  };

  const positional = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--mod=")) {
      args.mod = arg.slice("--mod=".length);
    } else if (arg.startsWith("--audio=")) {
      args.audio = arg.slice("--audio=".length);
      args.mod = "audio_file";
    } else if (arg.startsWith("--format=")) {
      args.format = arg.slice("--format=".length);
    } else if (arg.startsWith("--recv_timeout=")) {
      args.recvTimeout = parseInt(arg.slice("--recv_timeout=".length), 10);
    } else if (arg.startsWith("--speaker=")) {
      args.speaker = arg.slice("--speaker=".length);
    } else if (arg.startsWith("--greeting=")) {
      args.greeting = arg.slice("--greeting=".length);
    } else if (arg.startsWith("--output=")) {
      args.output = arg.slice("--output=".length);
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  args.textInput = positional.join(" ").trim();

  // 默认 recv_timeout: 音频模式 10s, 文本模式 120s
  if (args.recvTimeout === null) {
    args.recvTimeout = args.mod === "text" ? 120 : 10;
  }

  return args;
}

// ── 鉴权配置 ──

function loadConfig(args) {
  const baseUrl = getEnv("HEROS_DOUBAO_BASE_URL", "wss://openspeech.bytedance.com/api/v3/realtime/dialogue");
  const appId = getEnv("HEROS_DOUBAO_APP_ID");
  const accessKey = getEnv("HEROS_DOUBAO_ACCESS_KEY");
  const resourceId = getEnv("HEROS_DOUBAO_RESOURCE_ID", "volc.speech.dialog");
  const appKey = getEnv("HEROS_DOUBAO_APP_KEY", "PlgvMymc7f3tQnJ6");
  const botName = getEnv("HEROS_DOUBAO_BOT_NAME", "豆包");
  const systemRole = getEnv("HEROS_DOUBAO_SYSTEM_ROLE", "你使用活泼灵动的女声，性格开朗，热爱生活。");
  const speakingStyle = getEnv("HEROS_DOUBAO_SPEAKING_STYLE", "你的说话风格简洁明了，语速适中，语调自然。");

  if (!appId || !accessKey) {
    console.error("缺少鉴权：请在 .env.local 或环境变量里设置 HEROS_DOUBAO_APP_ID / HEROS_DOUBAO_ACCESS_KEY");
    process.exit(1);
  }

  return {
    baseUrl,
    appId,
    accessKey,
    resourceId,
    appKey,
    botName,
    systemRole,
    speakingStyle,
    speaker: args.speaker,
    greeting: args.greeting,
    recvTimeout: args.recvTimeout,
    outputFormat: args.format,
    inputMod: args.mod === "text" ? "text" : "audio",
  };
}

// ── 二进制协议层 ──

function concatBytes(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function int32Bytes(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function buildHeader(
  messageType = CLIENT_FULL_REQUEST,
  messageTypeSpecificFlags = MSG_WITH_EVENT,
  serialization = JSON_SERIALIZATION,
  compression = GZIP_COMPRESSION
) {
  return new Uint8Array([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | messageTypeSpecificFlags,
    (serialization << 4) | compression,
    0x00,
  ]);
}

function gzipJson(payload) {
  return gzipSync(Buffer.from(JSON.stringify(payload)));
}

function gzipBytes(data) {
  return gzipSync(Buffer.from(data));
}

function buildStartConnectionFrame() {
  const payload = gzipJson({});
  return concatBytes(buildHeader(), int32Bytes(1), int32Bytes(payload.length), payload);
}

function buildFinishConnectionFrame() {
  const payload = gzipJson({});
  return concatBytes(buildHeader(), int32Bytes(2), int32Bytes(payload.length), payload);
}

function buildStartSessionFrame(sessionId, payloadObj) {
  const sid = encoder.encode(sessionId);
  const payload = gzipJson(payloadObj);
  return concatBytes(
    buildHeader(), int32Bytes(100),
    int32Bytes(sid.length), sid,
    int32Bytes(payload.length), payload
  );
}

function buildFinishSessionFrame(sessionId) {
  const sid = encoder.encode(sessionId);
  const payload = gzipJson({});
  return concatBytes(
    buildHeader(), int32Bytes(102),
    int32Bytes(sid.length), sid,
    int32Bytes(payload.length), payload
  );
}

function buildSayHelloFrame(sessionId, content) {
  const sid = encoder.encode(sessionId);
  const payload = gzipJson({ content });
  return concatBytes(
    buildHeader(), int32Bytes(300),
    int32Bytes(sid.length), sid,
    int32Bytes(payload.length), payload
  );
}

function buildChatTextQueryFrame(sessionId, content) {
  const sid = encoder.encode(sessionId);
  const payload = gzipJson({ content });
  return concatBytes(
    buildHeader(), int32Bytes(501),
    int32Bytes(sid.length), sid,
    int32Bytes(payload.length), payload
  );
}

function buildChatTtsTextFrame(sessionId, content, start = true, end = true) {
  const sid = encoder.encode(sessionId);
  const payload = gzipJson({ start, content, end });
  return concatBytes(
    buildHeader(), int32Bytes(500),
    int32Bytes(sid.length), sid,
    int32Bytes(payload.length), payload
  );
}

function buildAudioFrame(sessionId, audioBytes) {
  const sid = encoder.encode(sessionId);
  const payload = gzipBytes(audioBytes);
  return concatBytes(
    buildHeader(CLIENT_AUDIO_ONLY_REQUEST, MSG_WITH_EVENT, NO_SERIALIZATION, GZIP_COMPRESSION),
    int32Bytes(200),
    int32Bytes(sid.length), sid,
    int32Bytes(payload.length), payload
  );
}

// ── 响应解析 ──

function parsePayload(payload, compression, serialization) {
  const raw = compression === GZIP_COMPRESSION ? new Uint8Array(gunzipSync(payload)) : payload;
  if (serialization === JSON_SERIALIZATION) {
    const text = decoder.decode(raw);
    return { payload: JSON.parse(text) };
  }
  if (serialization === NO_SERIALIZATION) {
    return { payload: null, payloadRaw: raw };
  }
  return { payload: decoder.decode(raw) };
}

export function parseDoubaoResponse(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) return null;

  const headerSize = bytes[0] & 0x0f;
  const messageType = bytes[1] >> 4;
  const messageTypeSpecificFlags = bytes[1] & 0x0f;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 0x0f;

  const payload = bytes.slice(headerSize * 4);

  if (messageType === SERVER_ERROR_RESPONSE) {
    if (payload.length < 8) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const code = view.getUint32(0, false);
    const payloadSize = view.getUint32(4, false);
    const payloadBytes = payload.slice(8, 8 + payloadSize);
    const decoded = parsePayload(payloadBytes, compression, serialization);
    return { messageType: "SERVER_ERROR", code, ...decoded };
  }

  let offset = 0;
  if (messageTypeSpecificFlags & 0b0010) offset += 4;

  let event;
  if (messageTypeSpecificFlags & MSG_WITH_EVENT) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    event = view.getUint32(offset, false);
    offset += 4;
  }

  if (payload.length < offset + 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sessionIdSize = view.getUint32(offset, false);
  offset += 4;
  const sessionId = decoder.decode(payload.slice(offset, offset + sessionIdSize));
  offset += sessionIdSize;
  const payloadSize = view.getUint32(offset, false);
  offset += 4;
  const payloadBytes = payload.slice(offset, offset + payloadSize);
  const decoded = parsePayload(payloadBytes, compression, serialization);

  return {
    messageType: messageType === SERVER_ACK ? "SERVER_ACK" : "SERVER_FULL_RESPONSE",
    event,
    sessionId,
    ...decoded,
  };
}

function isLikelyOpaqueId(text) {
  return /^[0-9a-fA-F-]{16,}$/.test(text.trim());
}

function isLikelyNoise(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^\d{12,}$/.test(t)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]+$/i.test(t)) return true;
  return false;
}

export function deepFindText(payload) {
  if (typeof payload === "string") return payload.trim() ? payload : null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const text = deepFindText(item);
      if (text) return text;
    }
    return null;
  }
  if (payload && typeof payload === "object") {
    const obj = payload;
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

export function shouldDisplayText(text) {
  if (!text) return false;
  if (isLikelyNoise(text)) return false;
  if (isLikelyOpaqueId(text)) return false;
  return true;
}

// ── WAV 文件解析 ──

function parseWavHeader(buffer) {
  if (buffer.length < 44) {
    throw new Error("WAV 文件太小，至少需要 44 字节头部");
  }
  const riff = decoder.decode(buffer.slice(0, 4));
  const wave = decoder.decode(buffer.slice(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("不是有效的 WAV 文件");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataOffset = 44;
  const dataSize = view.getUint32(40, true);
  return { channels, sampleRate, bitsPerSample, dataOffset, dataSize };
}

// ── WebSocket 连接管理 ──

export class DoubaoSession {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.sessionId = randomUUID();
    this.connectId = randomUUID();
    this.closed = false;
    this.phase = "idle";
    this.resolveReady = null;
    this.readyPromise = new Promise((r) => { this.resolveReady = r; });
  }

  async connect() {
    const headers = {
      "X-Api-App-ID": this.config.appId,
      "X-Api-Access-Key": this.config.accessKey,
      "X-Api-Resource-Id": this.config.resourceId,
      "X-Api-App-Key": this.config.appKey,
      "X-Api-Connect-Id": this.connectId,
    };

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.baseUrl, {
        headers,
        perMessageDeflate: false,
      });
      this.ws = ws;

      ws.on("open", () => {
        console.log(`[doubao] WebSocket 已连接 (sessionId=${this.sessionId})`);
        this.phase = "waiting_start_connection";
        ws.send(buildStartConnectionFrame());
        resolve();
      });

      ws.on("error", (err) => {
        reject(new Error(`WebSocket 连接失败: ${err?.message ?? err}`));
      });

      ws.on("close", (code, reasonBuffer) => {
        const reason = reasonBuffer ? reasonBuffer.toString("utf8") : "";
        if (!this.closed) {
          console.error(`[doubao] WebSocket 意外关闭 code=${code} reason=${reason}`);
        }
        this.cleanup();
      });
    });
  }

  cleanup() {
    this.closed = true;
    this.ws = null;
  }

  send(bytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }
    this.ws.send(bytes);
  }

  async sendStartSession() {
    const sessionPayload = {
      asr: { extra: { end_smooth_window_ms: 1500 } },
      tts: {
        speaker: this.config.speaker,
        audio_config: {
          channel: 1,
          format: this.config.outputFormat,
          sample_rate: OUTPUT_SAMPLE_RATE,
        },
      },
      dialog: {
        bot_name: this.config.botName,
        system_role: this.config.systemRole,
        speaking_style: this.config.speakingStyle,
        location: { city: "北京" },
        greeting: this.config.greeting,
        extra: {
          strict_audit: false,
          audit_response: "支持客户自定义安全审核回复话术。",
          recv_timeout: this.config.recvTimeout,
          input_mod: this.config.inputMod,
        },
      },
    };
    this.send(buildStartSessionFrame(this.sessionId, sessionPayload));
  }

  async sendSayHello() {
    this.send(buildSayHelloFrame(this.sessionId, this.config.greeting));
  }

  async sendTextQuery(text) {
    this.send(buildChatTextQueryFrame(this.sessionId, text));
  }

  async sendChatTtsText(text) {
    // Try single-frame (start=true, end=true) first — works with some server versions
    this.send(buildChatTtsTextFrame(this.sessionId, text, true, true));
  }

  async sendAudioChunk(audioBytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send(buildAudioFrame(this.sessionId, audioBytes));
  }

  async finishSession() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.send(buildFinishSessionFrame(this.sessionId));
    } catch { /* ignore */ }
  }

  async finishConnection() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.send(buildFinishConnectionFrame());
    } catch { /* ignore */ }
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    await this.finishSession();
    await this.finishConnection();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

// ── 音频工具 (使用 SoX) ── 从共享模块导入并重导出

import {
  isSoxAvailable,
  createAudioPlayer,
  writeToPlayer,
  stopPlayer,
  createAudioRecorder,
  stopRecorder,
  OUTPUT_SAMPLE_RATE,
  INPUT_SAMPLE_RATE,
  INPUT_CHUNK_FRAMES,
} from "../src/core/voice/audioUtils.mjs";

export {
  isSoxAvailable,
  createAudioPlayer,
  writeToPlayer,
  stopPlayer,
  createAudioRecorder,
  stopRecorder,
  OUTPUT_SAMPLE_RATE,
  INPUT_SAMPLE_RATE,
  INPUT_CHUNK_FRAMES,
};

// ── 音频模式 ──

async function runAudioMode(session, args, config) {
  const player = createAudioPlayer();
  if (player) {
    console.log("[audio] SoX 音频输出已就绪");
  }

  const recorder = createAudioRecorder();
  if (!recorder) {
    console.error("[audio] 需要 SoX 进行麦克风采集 (brew install sox)");
    process.exit(1);
  }
  console.log("[audio] SoX 音频输入已就绪");

  // 麦克风数据缓冲（凑够 200ms 再发送）
  const MIC_CHUNK_SIZE = INPUT_CHUNK_FRAMES * 2; // 6400 bytes
  let micBuffer = Buffer.alloc(0);

  // 状态管理
  let sayHelloDone = false;
  let micStarted = false;

  // 连接 + 握手
  await session.connect();

  // 注册消息处理
  session.ws.on("message", (raw) => {
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const parsed = parseDoubaoResponse(data);
    if (!parsed) return;

    if (parsed.messageType === "SERVER_ERROR") {
      console.error("[doubao] 服务端错误:", parsed.code, JSON.stringify(parsed.payload));
      return;
    }

    // 握手阶段
    if (session.phase === "waiting_start_connection") {
      session.phase = "waiting_start_session";
      console.log("[doubao] StartConnection 已响应，发送 StartSession...");
      session.sendStartSession();
      return;
    }

    if (session.phase === "waiting_start_session") {
      session.phase = "ready";
      console.log("[doubao] StartSession 已响应，Session 就绪");
      session.resolveReady();
      console.log(`[doubao] 发送 SayHello(300): "${config.greeting}"`);
      session.sendSayHello();
      return;
    }

    // 正常消息流
    if (parsed.messageType === "SERVER_ACK" && parsed.payloadRaw?.length) {
      // TTS 音频数据
      writeToPlayer(player, parsed.payloadRaw);
      return;
    }

    // SERVER_FULL_RESPONSE 事件处理
    const text = deepFindText(parsed.payload);

    if (parsed.event === 350) {
      const ttsType = parsed.payload?.tts_type ?? "unknown";
      console.log(`[doubao] TTSSentenceStart tts_type=${ttsType}`);
    } else if (parsed.event === 351) {
      console.log("[doubao] TTSSentenceEnd");
    } else if (parsed.event === 359) {
      console.log("[doubao] TTS 播报完成 (event=359)");
      if (!sayHelloDone) {
        sayHelloDone = true;
        const followUp = getEnv("HEROS_DOUBAO_FOLLOW_UP", "");
        const followUpText = followUp || "你好，我也叫豆包";
        console.log(`[doubao] 发送 ChatTextQuery(501): "${followUpText}"`);
        session.sendTextQuery(followUpText);
      }
    } else if (parsed.event === 450) {
      console.log("[doubao] 用户开始说话 (event=450)");
    } else if (parsed.event === 459) {
      console.log("[doubao] 用户说话结束 (event=459)");
    } else if (parsed.event === 451 && shouldDisplayText(text)) {
      console.log(`[doubao] ASR 识别: ${text}`);
    }

    if (text && parsed.event !== 451 && shouldDisplayText(text)) {
      console.log(`[doubao] 收到文本: ${text}`);
    }
  });

  // 等待 session 就绪
  await session.readyPromise;

  // 等待 SayHello TTS 完成后再启动麦克风
  console.log("[doubao] 等待 SayHello TTS 完成...");
  await new Promise((resolve) => setTimeout(resolve, 5000));
  sayHelloDone = true;
  micStarted = true;
  console.log("[doubao] 开始麦克风采集...");

  // 读取麦克风数据并发送（SoX rec → stdout）
  recorder.stdout.on("data", (chunk) => {
    if (session.closed) return;
    // 缓冲凑够 6400 bytes (200ms @ 16kHz 16-bit mono) 再发送
    micBuffer = Buffer.concat([micBuffer, chunk]);
    while (micBuffer.length >= MIC_CHUNK_SIZE) {
      const toSend = micBuffer.subarray(0, MIC_CHUNK_SIZE);
      micBuffer = micBuffer.subarray(MIC_CHUNK_SIZE);
      session.sendAudioChunk(toSend).catch(() => {});
    }
  });

  console.log("[doubao] 麦克风已启动，请说话...");
  console.log("[doubao] 按 Ctrl+C 退出");

  // 等待退出信号
  await new Promise((resolve) => {
    const onSignal = () => {
      console.log("\n[doubao] 收到退出信号，正在清理...");
      stopRecorder(recorder);
      stopPlayer(player);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

// ── 文本模式 ──

async function runTextMode(session, args, config) {
  // 设置音频播放（使用 SoX play）
  const player = createAudioPlayer();
  if (player) {
    console.log("[audio] 音频输出已就绪");
  } else {
    console.log("[audio] SoX 不可用 (brew install sox)，仅显示文本");
  }

  function enqueueAudio(pcmData) {
    writeToPlayer(player, pcmData);
  }

  await session.connect();

  session.ws.on("message", (raw) => {
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const parsed = parseDoubaoResponse(data);
    if (!parsed) return;

    if (parsed.messageType === "SERVER_ERROR") {
      console.error("[doubao] 服务端错误:", parsed.code, JSON.stringify(parsed.payload));
      return;
    }

    if (session.phase === "waiting_start_connection") {
      session.phase = "waiting_start_session";
      console.log("[doubao] StartConnection 已响应，发送 StartSession...");
      session.sendStartSession();
      return;
    }

    if (session.phase === "waiting_start_session") {
      session.phase = "ready";
      console.log("[doubao] Session 就绪");
      session.resolveReady();

      // 发送 SayHello
      if (config.greeting) {
        console.log(`[doubao] 发送 SayHello: "${config.greeting}"`);
        session.sendSayHello();
      }
      return;
    }

    // 处理响应
    const text = deepFindText(parsed.payload);
    if (parsed.messageType === "SERVER_ACK" && parsed.payloadRaw?.length) {
      // 播放 TTS 音频
      enqueueAudio(parsed.payloadRaw);
      return;
    }

    if (parsed.event === 359) {
      if (!session._sayHelloDone) {
        // 第一次 event=359: SayHello TTS 完成
        session._sayHelloDone = true;
        console.log("[doubao] SayHello TTS 完成 (event=359)");
        if (session._pendingTextQuery) {
          const pending = session._pendingTextQuery;
          session._pendingTextQuery = null;
          console.log(`[doubao] 发送 ChatTextQuery(501): "${pending}"`);
          session.sendTextQuery(pending);
        }
      } else {
        // 第二次 event=359: 查询响应 TTS 完成
        session._queryTtsDone = true;
        console.log("[doubao] 查询响应 TTS 完成 (event=359)");
      }
      return;
    }

    if (shouldDisplayText(text)) {
      console.log(`[doubao] 响应文本: ${text}`);
    }

    if (parsed.event === 350) {
      console.log(`[doubao] TTSSentenceStart`);
    } else if (parsed.event === 351) {
      console.log("[doubao] TTSSentenceEnd");
    }

    if (parsed.event === 152 || parsed.event === 153) {
      console.log("[doubao] 会话结束");
      session._queryTtsDone = true;
    }
  });

  await session.readyPromise;

  // 等待 SayHello TTS 完成
  session._sayHelloDone = false;
  session._pendingTextQuery = null;
  session._queryTtsDone = false;

  let textInput;
  if (args.textInput) {
    textInput = args.textInput;
  } else {
    // 从 stdin 读取
    textInput = await new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("请输入文本: ", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!textInput) {
    console.log("[doubao] 未输入文本，退出");
    await session.shutdown();
    return;
  }

  console.log(`[doubao] 输入: "${textInput}"`);

  // 等待 SayHello 完成或超时后再发送查询
  if (!session._sayHelloDone) {
    console.log("[doubao] 等待 SayHello 完成...");
    // 等待 event=359 或超时 3s
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (session._sayHelloDone || session.closed) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 3000);
    });
  }

  session._pendingTextQuery = null;
  session.sendTextQuery(textInput);

  // 等待响应（recv_timeout + 一些缓冲）
  const waitMs = (config.recvTimeout + 10) * 1000;
  console.log(`[doubao] 等待响应 (最长 ${config.recvTimeout + 10}s)...`);
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log("[doubao] 接收超时");
      resolve();
    }, waitMs);
    // 轮询检测完成条件
    const checkDone = setInterval(() => {
      if (session._queryTtsDone || session.closed) {
        clearInterval(checkDone);
        clearTimeout(timer);
        console.log("[doubao] 响应完成");
        resolve();
      }
    }, 500);
    session.ws.on("close", () => {
      clearInterval(checkDone);
      clearTimeout(timer);
      resolve();
    });
  });

  // 等待音频播放完成
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 清理音频
  stopPlayer(player);

  await session.shutdown();
}

// ── 音频文件模式 ──

async function runAudioFileMode(session, args, config) {
  const audioPath = args.audio;
  if (!audioPath) {
    console.error("错误：音频文件模式需要 --audio=<path> 参数");
    process.exit(1);
  }

  const resolvedPath = resolve(audioPath);
  if (!existsSync(resolvedPath)) {
    console.error(`错误：音频文件不存在: ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`[doubao] 读取音频文件: ${resolvedPath}`);
  const fileBuffer = readFileSync(resolvedPath);
  const { channels, sampleRate, bitsPerSample, dataOffset, dataSize } = parseWavHeader(fileBuffer);
  console.log(`[doubao] WAV: ${sampleRate}Hz, ${channels}ch, ${bitsPerSample}bit, ${dataSize} bytes PCM`);

  // 提取 PCM 数据
  const pcmData = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset + dataOffset, dataSize);

  // 输出文件
  const outputPath = args.output || resolvedPath.replace(/\.wav$/i, "_output.pcm");
  console.log(`[doubao] 输出文件: ${outputPath}`);
  const outFile = createWriteStream(outputPath);

  const outputPcmPath = resolve(outputPath);

  await session.connect();

  let gotTts = false;
  let totalAudioBytes = 0;

  session.ws.on("message", (raw) => {
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const parsed = parseDoubaoResponse(data);
    if (!parsed) return;

    if (parsed.messageType === "SERVER_ERROR") {
      console.error("[doubao] 服务端错误:", parsed.code, JSON.stringify(parsed.payload));
      return;
    }

    if (session.phase === "waiting_start_connection") {
      session.phase = "waiting_start_session";
      console.log("[doubao] StartConnection 已响应，发送 StartSession...");
      session.sendStartSession();
      return;
    }

    if (session.phase === "waiting_start_session") {
      session.phase = "ready";
      console.log("[doubao] Session 就绪，开始发送音频数据...");
      session.resolveReady();
      return;
    }

    // 收集 TTS 音频
    if (parsed.messageType === "SERVER_ACK" && parsed.payloadRaw?.length) {
      gotTts = true;
      totalAudioBytes += parsed.payloadRaw.length;
      outFile.write(Buffer.from(parsed.payloadRaw));
      return;
    }

    const text = deepFindText(parsed.payload);
    if (shouldDisplayText(text)) {
      console.log(`[doubao] 响应文本: ${text}`);
    }

    if (parsed.event === 350) {
      console.log("[doubao] TTSSentenceStart");
    } else if (parsed.event === 351) {
      console.log("[doubao] TTSSentenceEnd");
    } else if (parsed.event === 359) {
      console.log("[doubao] TTS 完成 (event=359)");
    } else if (parsed.event === 152 || parsed.event === 153) {
      console.log("[doubao] 会话结束");
    }
  });

  await session.readyPromise;

  // 分块发送音频（模拟实时速率）
  const chunkSize = INPUT_CHUNK_FRAMES * (bitsPerSample / 8) * channels;
  const chunkDelayMs = (INPUT_CHUNK_FRAMES / sampleRate) * 1000;

  let offset = 0;
  let chunkIndex = 0;
  while (offset < pcmData.length && !session.closed) {
    const end = Math.min(offset + chunkSize, pcmData.length);
    const chunk = pcmData.slice(offset, end);
    try {
      session.sendAudioChunk(chunk);
    } catch {
      break;
    }
    offset = end;
    chunkIndex++;
    if (chunkIndex % 5 === 0) {
      console.log(`[doubao] 已发送 ${chunkIndex} 块 (${((offset / pcmData.length) * 100).toFixed(1)}%)`);
    }
    // 模拟实时速率
    await new Promise((r) => setTimeout(r, chunkDelayMs));
  }

  console.log(`[doubao] 音频发送完成，共 ${chunkIndex} 块`);

  // 等待服务端处理完成
  console.log("[doubao] 等待服务端处理...");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log("[doubao] 接收超时");
      resolve();
    }, (config.recvTimeout + 20) * 1000);

    const checkDone = setInterval(() => {
      if (session.closed) {
        clearTimeout(timer);
        clearInterval(checkDone);
        resolve();
      }
    }, 500);

    // 收到会话结束事件后等待一下再退出
    session.ws.on("close", () => {
      clearTimeout(timer);
      clearInterval(checkDone);
      resolve();
    });
  });

  outFile.end();
  console.log(`[doubao] 完成! TTS 音频: ${totalAudioBytes} bytes → ${outputPcmPath}`);
  await session.shutdown();
}

// ── 主入口 ──

async function main() {
  const args = parseArgs();
  const config = loadConfig(args);

  console.log("═══════════════════════════════════════");
  console.log(`  豆包端到端语音 CLI - ${args.mod} 模式`);
  console.log("═══════════════════════════════════════");
  console.log(`  endpoint: ${config.baseUrl}`);
  console.log(`  speaker:  ${config.speaker}`);
  console.log(`  greeting: ${config.greeting}`);
  console.log(`  timeout:  ${config.recvTimeout}s`);
  console.log("");

  const session = new DoubaoSession(config);

  // 全局信号处理
  const onGlobalSignal = async () => {
    console.log("\n[doubao] 正在退出...");
    await session.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", onGlobalSignal);
  process.once("SIGTERM", onGlobalSignal);

  try {
    if (args.mod === "text") {
      await runTextMode(session, args, config);
    } else if (args.mod === "audio_file") {
      await runAudioFileMode(session, args, config);
    } else {
      await runAudioMode(session, args, config);
    }
  } catch (err) {
    console.error("[doubao] 运行错误:", err.message);
    await session.shutdown();
    process.exit(1);
  }

  console.log("[doubao] 退出");
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}

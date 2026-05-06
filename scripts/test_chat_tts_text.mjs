#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;

const CLIENT_FULL_REQUEST = 0b0001;
const CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const MSG_WITH_EVENT = 0b0100;
const NO_SERIALIZATION = 0b0000;
const JSON_SERIALIZATION = 0b0001;
const NO_COMPRESSION = 0b0000;
const GZIP_COMPRESSION = 0b0001;

const SERVER_ACK = 0b1011;
const SERVER_ERROR_RESPONSE = 0b1111;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ── Env helpers ──

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
    env[key] = value;
  }
  return env;
}

function getEnv(name, fallback = "") {
  if (process.env[name]) return process.env[name];
  if (localEnv[name]) return localEnv[name];
  return fallback;
}

// ── Binary helpers ──

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
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

// ── Frame builders ──

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
    buildHeader(),
    int32Bytes(100),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

function buildFinishSessionFrame(sessionId) {
  const sid = encoder.encode(sessionId);
  const payload = gzipJson({});
  return concatBytes(
    buildHeader(),
    int32Bytes(102),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

function buildHelloFrame(sessionId, content) {
  const sid = encoder.encode(sessionId);
  const payload = gzipJson({ content });
  return concatBytes(
    buildHeader(),
    int32Bytes(300),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

function buildChatTtsTextFrame(sessionId, payloadObj) {
  const sid = encoder.encode(sessionId);
  const payload = gzipJson(payloadObj);
  return concatBytes(
    buildHeader(),
    int32Bytes(500),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

function buildAudioFrame(sessionId, audioBytes) {
  const sid = encoder.encode(sessionId);
  const payload = gzipSync(audioBytes);
  return concatBytes(
    buildHeader(CLIENT_AUDIO_ONLY_REQUEST, MSG_WITH_EVENT, NO_SERIALIZATION, GZIP_COMPRESSION),
    int32Bytes(200),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

// ── Parser ──

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

function parseDoubaoResponse(data) {
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

// ── Config ──

const localEnv = loadEnvFile(resolve(process.cwd(), ".env.local"));
const baseUrl = getEnv("HEROS_DOUBAO_BASE_URL", "wss://openspeech.bytedance.com/api/v3/realtime/dialogue");
const appId = getEnv("HEROS_DOUBAO_APP_ID");
const accessKey = getEnv("HEROS_DOUBAO_ACCESS_KEY");
const resourceId = getEnv("HEROS_DOUBAO_RESOURCE_ID", "volc.speech.dialog");
const appKey = getEnv("HEROS_DOUBAO_APP_KEY", "PlgvMymc7f3tQnJ6");
const speaker = getEnv("HEROS_DOUBAO_SPEAKER", "zh_female_xiaohe_jupiter_bigtts");
const botName = getEnv("HEROS_DOUBAO_BOT_NAME", "豆包");
const systemRole = getEnv("HEROS_DOUBAO_SYSTEM_ROLE", "你使用活泼灵动的女声，性格开朗，热爱生活。");
const speakingStyle = getEnv("HEROS_DOUBAO_SPEAKING_STYLE", "你的说话风格简洁明了，语速适中，语调自然。");
const greeting = getEnv("HEROS_DOUBAO_GREETING", "你好");

// Test text and format option
const args = process.argv.slice(2);
const formatFlag = args.find(x => x === "--simple" || x === "--startend" || x === "--content-only") || "--simple";
const ttsText = args.filter(x => !x.startsWith("--")).join(" ").trim() || "这是一条通过ChatTTSText接口合成的测试语音。";

if (!appId || !accessKey) {
  console.error("缺少鉴权：请在 .env.local 或环境变量里设置 HEROS_DOUBAO_APP_ID / HEROS_DOUBAO_ACCESS_KEY");
  process.exit(1);
}

const sessionId = randomUUID();
const connectId = randomUUID();

const headers = {
  "X-Api-App-ID": appId,
  "X-Api-Access-Key": accessKey,
  "X-Api-Resource-Id": resourceId,
  "X-Api-App-Key": appKey,
  "X-Api-Connect-Id": connectId,
};

const sessionPayload = {
  asr: { extra: { end_smooth_window_ms: 1500 } },
  tts: {
    speaker,
    audio_config: { channel: 1, format: "pcm_s16le", sample_rate: 24000 },
  },
  dialog: {
    bot_name: botName,
    system_role: systemRole,
    speaking_style: speakingStyle,
    location: { city: "北京" },
    greeting,
    extra: {
      strict_audit: false,
      audit_response: "支持客户自定义安全审核回复话术。",
      recv_timeout: 10,
      input_mod: "audio",
    },
  },
};

function getChatTtsPayload(text, mode) {
  switch (mode) {
    case "--startend":
      // Two-packet streaming format (iOS SDK style)
      return [
        { start: true, content: text, end: false },
        { start: false, content: "", end: true },
      ];
    case "--content-only":
      // Simple {content} format (rtc-volcengine-third-ts style)
      return [{ content: text }];
    case "--simple":
    default:
      // Single-packet with both start and end
      return [{ start: true, content: text, end: true }];
  }
}

// ── Main test ──

const chatTtsPayloads = getChatTtsPayload(ttsText, formatFlag);

console.log("═══════════════════════════════════════════");
console.log("  ChatTtsText (event=500) 独立测试");
console.log("═══════════════════════════════════════════");
console.log(`baseUrl: ${baseUrl}`);
console.log(`sessionId: ${sessionId}`);
console.log(`TTS text: "${ttsText}"`);
console.log(`Format: ${formatFlag}`);
console.log(`Packets: ${chatTtsPayloads.length}`);
console.log("");

const ws = new WebSocket(baseUrl, {
  headers,
  perMessageDeflate: false,
});

let phase = "handshake";
let closed = false;
let totalAudioBytes = 0;
let ttsSentenceCount = 0;
let gotTtsEnded = false;
let gotChatTtsSentenceStart = false;

function cleanup(exitCode, reason) {
  if (closed) return;
  closed = true;
  if (reason) console.log(`\n[cleanup] reason: ${reason}`);
  try {
    if (ws.readyState === WebSocket.OPEN) {
      console.log("[cleanup] sending FinishSession + FinishConnection...");
      ws.send(buildFinishSessionFrame(sessionId));
      ws.send(buildFinishConnectionFrame());
    }
  } catch {
    // ignore
  }
  try { ws.close(); } catch { /* ignore */ }
  clearTimeout(timeout);
  process.exit(exitCode);
}

const timeout = setTimeout(() => {
  console.error("\n[TIMEOUT] 30s 内测试未完成");
  console.error(`  当前 phase: ${phase}`);
  console.error(`  总收到音频: ${totalAudioBytes} bytes`);
  console.error(`  TTSSentenceStart 次数: ${ttsSentenceCount}`);
  console.error(`  收到 ChatTtsText 的 TTSSentenceStart: ${gotChatTtsSentenceStart}`);
  console.error(`  收到 TTSEnded: ${gotTtsEnded}`);
  cleanup(1, "timeout");
}, 40000);

ws.on("open", () => {
  console.log("[ws] connected, sending StartConnection...");
  ws.send(buildStartConnectionFrame());
});

ws.on("message", (raw) => {
  const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const parsed = parseDoubaoResponse(data);
  if (!parsed) return;

  const eventTag = parsed.event != null ? `event=${parsed.event}` : "event=N/A";
  const typeTag = parsed.messageType;

  if (parsed.messageType === "SERVER_ERROR") {
    console.error(`[ERROR] code=${parsed.code} payload=`, parsed.payload);
    cleanup(1, "server_error");
    return;
  }

  // ── Handshake ──
  if (phase === "handshake") {
    console.log(`[handshake] <= ${typeTag} ${eventTag}`);
    phase = "waiting_start_session";
    console.log("[handshake] => StartSession");
    ws.send(buildStartSessionFrame(sessionId, sessionPayload));
    return;
  }

  if (phase === "waiting_start_session") {
    console.log(`[start_session] <= ${typeTag} ${eventTag}`);
    phase = "waiting_hello_tts";
    console.log("[start_session] => SayHello(300)");
    ws.send(buildHelloFrame(sessionId, greeting));
    return;
  }

  // ── Audio chunks (may appear in any phase) ──
  if (parsed.messageType === "SERVER_ACK" && parsed.payloadRaw?.length) {
    if (phase === "waiting_chat_tts") {
      console.log(`[chat_tts] <= audio=${parsed.payloadRaw.length}B`);
      totalAudioBytes += parsed.payloadRaw.length;
    }
    return;
  }

  // ── Waiting for greeting TTS ──
  if (phase === "waiting_hello_tts") {
    if (parsed.event === 359) {
      console.log("[hello_tts] Greeting TTS done (event=359), sending speech-like audio to trigger ASR...");
      phase = "sending_audio";

      const wavBuf = readFileSync(resolve(process.cwd(), "whoareyou.wav"));
      // Strip 44-byte WAV header to get raw PCM
      const audioBuf = wavBuf.slice(44);
      // Append 1s of silence for VAD to detect end-of-speech transition
      const silenceBuf = Buffer.alloc(32000); // 1s at 16kHz 16-bit
      const fullAudio = Buffer.concat([audioBuf, silenceBuf]);
      const CHUNK_BYTES = 3200; // ~100ms at 16kHz 16-bit
      let sentBytes = 0;

      const audioInterval = setInterval(() => {
        if (phase !== "sending_audio" || closed) {
          clearInterval(audioInterval);
          return;
        }
        const end = Math.min(sentBytes + CHUNK_BYTES, fullAudio.length);
        if (sentBytes >= fullAudio.length) {
          clearInterval(audioInterval);
          console.log(`[audio] Done sending speech+silence (${fullAudio.length}B), waiting for ASR_ENDED...`);
          return;
        }
        ws.send(buildAudioFrame(sessionId, fullAudio.slice(sentBytes, end)));
        sentBytes = end;
      }, 100);
    }
    return;
  }

  // ── Waiting for ASR_ENDED (after sending audio) ──
  if (phase === "sending_audio") {
    if (parsed.messageType === "SERVER_ACK" && parsed.payloadRaw?.length) {
      return;
    }

    const payloadStr = parsed.payload != null ? JSON.stringify(parsed.payload).slice(0, 150) : "-";
    console.log(`[audio] <= ${typeTag} ${eventTag} payload=${payloadStr}`);

    if (parsed.event === 459) {
      console.log("[audio] ASR_ENDED (event=459), sending ChatTtsText...");
      phase = "waiting_chat_tts";
      for (const p of chatTtsPayloads) {
        console.log(`[chat_tts] => ${JSON.stringify(p).slice(0, 80)}`);
        ws.send(buildChatTtsTextFrame(sessionId, p));
      }
    }
    return;
  }

  // ── Waiting for ChatTtsText TTS ──
  if (phase === "waiting_chat_tts") {
    const payloadStr = parsed.payload != null ? JSON.stringify(parsed.payload).slice(0, 200) : "-";
    console.log(`[chat_tts] <= ${typeTag} ${eventTag} payload=${payloadStr}`);

    if (parsed.event === 350) {
      ttsSentenceCount++;
      const ttsType = parsed.payload?.tts_type ?? "unknown";
      console.log(`[chat_tts] ⚡ TTSSentenceStart tts_type=${ttsType}`);
      if (ttsType === "chat_tts_text" || ttsType === "default") {
        gotChatTtsSentenceStart = true;
      }
    } else if (parsed.event === 351) {
      console.log("[chat_tts] ⚡ TTSSentenceEnd");
    } else if (parsed.event === 359) {
      gotTtsEnded = true;
      console.log("[chat_tts] ⚡ TTSEnded");
      phase = "done";

      console.log("\n═══════════════════════════════════════════");
      console.log("  测试结果");
      console.log("═══════════════════════════════════════════");
      console.log(`  格式: ${formatFlag}`);
      console.log(`  TTSSentenceStart (chat_tts_text): ${gotChatTtsSentenceStart ? "PASS" : "FAIL"}`);
      console.log(`  总 TTSSentenceStart 次数: ${ttsSentenceCount}`);
      console.log(`  TTSEnded: ${gotTtsEnded ? "PASS" : "FAIL"}`);
      console.log(`  总收到音频: ${totalAudioBytes} bytes`);
      console.log("═══════════════════════════════════════════");
      cleanup(gotChatTtsSentenceStart && gotTtsEnded && totalAudioBytes > 0 ? 0 : 1, "test_complete");
    }
    return;
  }
});

ws.on("error", (err) => {
  console.error("[ws] error:", err?.message ?? err);
});

ws.on("close", (code, reasonBuffer) => {
  if (!closed) {
    const reason = reasonBuffer ? reasonBuffer.toString("utf8") : "";
    console.error(`[ws] closed unexpectedly: code=${code} reason=${reason}`);
    cleanup(1, "ws_closed");
  }
});

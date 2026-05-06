import pako from "pako";

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

function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text);
  }
  const binary = unescape(encodeURIComponent(text));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(bytes);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  try {
    return decodeURIComponent(escape(binary));
  } catch {
    return binary;
  }
}

export type DoubaoMessageType = "SERVER_FULL_RESPONSE" | "SERVER_ACK" | "SERVER_ERROR";

export interface DoubaoParsedResponse {
  messageType: DoubaoMessageType;
  event?: number;
  sessionId?: string;
  payload?: unknown;
  payloadRaw?: Uint8Array;
  code?: number;
}

function encodeJsonGzip(payload: unknown): Uint8Array {
  const bytes = utf8Encode(JSON.stringify(payload ?? {}));
  return pako.gzip(bytes);
}

function encodeBytesGzip(payload: Uint8Array): Uint8Array {
  return pako.gzip(payload);
}

function buildHeader(
  messageType: number = CLIENT_FULL_REQUEST,
  messageTypeSpecificFlags: number = MSG_WITH_EVENT,
  serialization: number = JSON_SERIALIZATION,
  compression: number = GZIP_COMPRESSION
): Uint8Array {
  return new Uint8Array([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | messageTypeSpecificFlags,
    (serialization << 4) | compression,
    0x00,
  ]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function int32Bytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, value, false);
  return out;
}

export function buildStartConnectionFrame(): Uint8Array {
  const payload = encodeJsonGzip({});
  return concatBytes(buildHeader(), int32Bytes(1), int32Bytes(payload.length), payload);
}

export function buildFinishConnectionFrame(): Uint8Array {
  const payload = encodeJsonGzip({});
  return concatBytes(buildHeader(), int32Bytes(2), int32Bytes(payload.length), payload);
}

export function buildStartSessionFrame(sessionId: string, payloadObj: unknown): Uint8Array {
  const sid = utf8Encode(sessionId);
  const payload = encodeJsonGzip(payloadObj);
  return concatBytes(
    buildHeader(),
    int32Bytes(100),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

export function buildFinishSessionFrame(sessionId: string): Uint8Array {
  const sid = utf8Encode(sessionId);
  const payload = encodeJsonGzip({});
  return concatBytes(
    buildHeader(),
    int32Bytes(102),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

export function buildChatTextQueryFrame(sessionId: string, content: string): Uint8Array {
  const sid = utf8Encode(sessionId);
  const payload = encodeJsonGzip({ content });
  return concatBytes(
    buildHeader(),
    int32Bytes(501),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

// ChatTTSText (event 500): send text directly to TTS synthesis, bypassing S2S chat generation.
// Payload: { start: bool, content: string, end: bool }
// Two-packet flow: first {start:true, end:false, content:"..."} then {start:false, end:true, content:""}
// Ref: https://www.volcengine.com/docs/6561/1594356
export function buildChatTtsTextFrame(
  sessionId: string,
  content: string,
  start = true,
  end = true
): Uint8Array {
  const sid = utf8Encode(sessionId);
  const payload = encodeJsonGzip({ start, content, end });
  return concatBytes(
    buildHeader(),
    int32Bytes(500),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

export function buildHelloFrame(sessionId: string, content: string): Uint8Array {
  const sid = utf8Encode(sessionId);
  const payload = encodeJsonGzip({ content });
  return concatBytes(
    buildHeader(),
    int32Bytes(300),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

export function buildAudioFrame(sessionId: string, audioBytes: Uint8Array): Uint8Array {
  const sid = utf8Encode(sessionId);
  const payload = encodeBytesGzip(audioBytes);
  return concatBytes(
    buildHeader(CLIENT_AUDIO_ONLY_REQUEST, MSG_WITH_EVENT, NO_SERIALIZATION, GZIP_COMPRESSION),
    int32Bytes(200),
    int32Bytes(sid.length),
    sid,
    int32Bytes(payload.length),
    payload
  );
}

function decodeMaybeCompressedPayload(
  payload: Uint8Array,
  compression: number,
  serialization: number
): { payload: unknown; payloadRaw?: Uint8Array } {
  const raw = compression === GZIP_COMPRESSION ? pako.ungzip(payload) : payload;

  if (serialization === JSON_SERIALIZATION) {
    const text = utf8Decode(raw);
    return { payload: JSON.parse(text) };
  }

  if (serialization === NO_SERIALIZATION) {
    return { payload: null, payloadRaw: raw };
  }

  return { payload: utf8Decode(raw) };
}

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

export function parseDoubaoResponse(data: ArrayBuffer | Uint8Array): DoubaoParsedResponse | null {
  const bytes = toUint8Array(data);
  if (bytes.length < 4) {
    return null;
  }

  const headerSize = bytes[0] & 0x0f;
  const messageType = bytes[1] >> 4;
  const messageTypeSpecificFlags = bytes[1] & 0x0f;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 0x0f;

  let payload = bytes.slice(headerSize * 4);
  let offset = 0;

  if (messageType === SERVER_ERROR_RESPONSE) {
    if (payload.length < 8) {
      return null;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const code = view.getUint32(0, false);
    const payloadSize = view.getUint32(4, false);
    const payloadBytes = payload.slice(8, 8 + payloadSize);
    const decoded = decodeMaybeCompressedPayload(payloadBytes, compression, serialization);
    return {
      messageType: "SERVER_ERROR",
      code,
      payload: decoded.payload,
      payloadRaw: decoded.payloadRaw,
    };
  }

  let seqOrEventStart = 0;
  if (messageTypeSpecificFlags & 0b0010) {
    seqOrEventStart += 4;
  }

  let event: number | undefined;
  if (messageTypeSpecificFlags & MSG_WITH_EVENT) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    event = view.getUint32(seqOrEventStart, false);
    seqOrEventStart += 4;
  }
  offset = seqOrEventStart;

  if (payload.length < offset + 8) {
    return null;
  }
  const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sessionIdSize = payloadView.getUint32(offset, false);
  offset += 4;
  const sessionIdBytes = payload.slice(offset, offset + sessionIdSize);
  const sessionId = utf8Decode(sessionIdBytes);
  offset += sessionIdSize;

  const payloadSize = payloadView.getUint32(offset, false);
  offset += 4;
  const payloadBytes = payload.slice(offset, offset + payloadSize);
  const decoded = decodeMaybeCompressedPayload(payloadBytes, compression, serialization);

  return {
    messageType: messageType === SERVER_ACK ? "SERVER_ACK" : "SERVER_FULL_RESPONSE",
    event,
    sessionId,
    payload: decoded.payload,
    payloadRaw: decoded.payloadRaw,
  };
}

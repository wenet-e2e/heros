import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

function createEventId() {
  return `event_${crypto.randomUUID().replaceAll('-', '')}`;
}

function websocketAccept(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) {
    headerLength += 2;
  } else if (length > 0xffff) {
    headerLength += 8;
  }
  headerLength += 4;

  const frame = Buffer.alloc(headerLength + length);
  frame[0] = 0x80 | opcode;
  let offset = 2;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }

  const mask = crypto.randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;
  for (let i = 0; i < length; i += 1) {
    frame[offset + i] = data[i] ^ mask[i % 4];
  }
  return frame;
}

export class RawWebSocket extends EventEmitter {
  constructor(url, headers = {}) {
    super();
    this.url = new URL(url);
    this.headers = headers;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.open = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const port = Number(this.url.port || (this.url.protocol === 'wss:' ? 443 : 80));
      const host = this.url.hostname;
      const path = `${this.url.pathname}${this.url.search}`;
      const socketOptions = { host, port, servername: host };
      const socket = this.url.protocol === 'wss:' ? tls.connect(socketOptions) : net.connect(socketOptions);
      this.socket = socket;

      let handshake = Buffer.alloc(0);
      let settled = false;

      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.emit('error', error);
      };

      socket.once('connect', () => {
        const requestHeaders = [
          `GET ${path} HTTP/1.1`,
          `Host: ${this.url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(this.headers).map(([name, value]) => `${name}: ${value}`),
          '\r\n',
        ].join('\r\n');
        socket.write(requestHeaders);
      });

      socket.on('data', (chunk) => {
        if (!this.open) {
          handshake = Buffer.concat([handshake, chunk]);
          const headerEnd = handshake.indexOf('\r\n\r\n');
          if (headerEnd === -1) {
            return;
          }
          const headerText = handshake.slice(0, headerEnd).toString('utf8');
          const lines = headerText.split('\r\n');
          const statusLine = lines.shift() || '';
          const statusCode = Number(statusLine.split(' ')[1]);
          const responseHeaders = Object.fromEntries(
            lines.map((line) => {
              const colon = line.indexOf(':');
              return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
            }),
          );
          if (statusCode !== 101) {
            fail(new Error(`WebSocket upgrade failed: ${statusLine}`));
            socket.destroy();
            return;
          }
          if (responseHeaders['sec-websocket-accept'] !== websocketAccept(key)) {
            fail(new Error('WebSocket upgrade failed: invalid accept header'));
            socket.destroy();
            return;
          }
          this.open = true;
          this.emit('open');
          if (!settled) {
            settled = true;
            resolve();
          }
          const remaining = handshake.slice(headerEnd + 4);
          if (remaining.length > 0) {
            this.buffer = Buffer.concat([this.buffer, remaining]);
            this.processFrames();
          }
          return;
        }

        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processFrames();
      });

      socket.on('close', () => {
        this.open = false;
        this.emit('close');
      });
      socket.on('error', fail);
    });
  }

  processFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const masked = Boolean(second & 0x80);
      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) {
          return;
        }
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) {
        return;
      }

      let payload = this.buffer.slice(offset, offset + length);
      this.buffer = this.buffer.slice(offset + length);
      if (masked) {
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      if (opcode === 0x1) {
        this.emit('message', payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this.open = false;
        this.socket.end();
        this.emit('close');
      } else if (opcode === 0x9) {
        this.sendFrame(0x0a, payload);
      }
    }
  }

  sendFrame(opcode, payload) {
    if (!this.socket || !this.open) {
      throw new Error('WebSocket is not open');
    }
    this.socket.write(encodeFrame(opcode, payload));
  }

  sendText(text) {
    this.sendFrame(0x1, text);
  }

  close() {
    if (this.socket && this.open) {
      this.sendFrame(0x8, Buffer.alloc(0));
    }
    this.socket?.end();
    this.open = false;
  }
}

export class DashScopeRealtimeClient extends EventEmitter {
  constructor({ apiKey, url, model }) {
    super();
    this.apiKey = apiKey;
    this.url = new URL(url);
    this.url.searchParams.set('model', model);
    this.model = model;
    this.ws = null;
  }

  async connect() {
    this.ws = new RawWebSocket(this.url.toString(), {
      Authorization: `Bearer ${this.apiKey}`,
    });
    this.ws.on('message', (text) => {
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        event = { type: 'raw.message', text };
      }
      this.emit('event', event);
      this.emit(event.type, event);
    });
    this.ws.on('close', () => this.emit('close'));
    this.ws.on('error', (error) => this.emit('error', error));
    await this.ws.connect();
  }

  send(event) {
    const payload = {
      event_id: createEventId(),
      ...event,
    };
    this.ws.sendText(JSON.stringify(payload));
    return payload.event_id;
  }

  updateSession({
    modalities = ['text', 'audio'],
    voice = 'Ethan',
    instructions,
    turnDetection = null,
    enableSearch = false,
  }) {
    const session = {
      modalities,
      voice,
      input_audio_format: 'pcm',
      output_audio_format: 'pcm',
      instructions,
      turn_detection: turnDetection,
    };
    if (enableSearch) {
      session.enable_search = true;
      session.search_options = { enable_source: true };
    }
    return this.send({ type: 'session.update', session });
  }

  appendAudio(buffer) {
    return this.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(buffer).toString('base64'),
    });
  }

  commitAudio() {
    return this.send({ type: 'input_audio_buffer.commit' });
  }

  createResponse() {
    return this.send({ type: 'response.create' });
  }

  cancelResponse() {
    return this.send({ type: 'response.cancel' });
  }

  waitFor(types, timeoutMs = 15000) {
    const wanted = Array.isArray(types) ? types : [types];
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for realtime event: ${wanted.join(', ')}`));
      }, timeoutMs);
      const onEvent = (event) => {
        if (wanted.includes(event.type)) {
          cleanup();
          resolve(event);
        } else if (event.type === 'error') {
          cleanup();
          reject(new Error(event.error?.message || JSON.stringify(event)));
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('event', onEvent);
      };
      this.on('event', onEvent);
    });
  }

  close() {
    this.ws?.close();
  }
}

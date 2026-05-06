import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import {
  buildStartConnectionFrame,
  buildFinishConnectionFrame,
  buildStartSessionFrame,
  buildFinishSessionFrame,
  buildHelloFrame,
  buildChatTextQueryFrame,
  buildChatTtsTextFrame,
  buildAudioFrame,
  parseDoubaoResponse,
  type DoubaoParsedResponse,
} from "./doubaoProtocol";

export interface DoubaoSessionConfig {
  baseUrl: string;
  appId: string;
  accessKey: string;
  resourceId: string;
  appKey: string;
  speaker: string;
  botName: string;
  systemRole: string;
  speakingStyle: string;
  greeting: string;
  recvTimeout: number;
  outputFormat: string;
  inputMod: "text" | "audio";
}

type SessionPhase = "idle" | "waiting_start_connection" | "waiting_start_session" | "ready";

export class DoubaoSession {
  config: DoubaoSessionConfig;
  ws: WebSocket | null = null;
  sessionId: string;
  connectId: string;
  closed = false;
  phase: SessionPhase = "idle";
  resolveReady: (() => void) | null = null;
  readyPromise: Promise<void>;

  constructor(config: DoubaoSessionConfig) {
    this.config = config;
    this.sessionId = randomUUID();
    this.connectId = randomUUID();
    this.readyPromise = new Promise((r) => {
      this.resolveReady = r;
    });
  }

  async connect(): Promise<void> {
    const headers: Record<string, string> = {
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

      ws.on("close", (_code, _reasonBuffer) => {
        if (!this.closed) {
          const reason = _reasonBuffer ? _reasonBuffer.toString("utf8") : "";
          console.error(`[doubao] WebSocket 意外关闭 code=${_code} reason=${reason}`);
        }
        this.cleanup();
      });
    });
  }

  cleanup(): void {
    this.closed = true;
    this.ws = null;
  }

  send(bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }
    this.ws.send(bytes);
  }

  sendStartSession(): void {
    const OUTPUT_SAMPLE_RATE = 24000;
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

  sendSayHello(): void {
    this.send(buildHelloFrame(this.sessionId, this.config.greeting));
  }

  sendTextQuery(text: string): void {
    this.send(buildChatTextQueryFrame(this.sessionId, text));
  }

  sendChatTtsText(text: string): void {
    this.send(buildChatTtsTextFrame(this.sessionId, text, true, false));
    this.send(buildChatTtsTextFrame(this.sessionId, " ", false, true));
  }

  sendAudioChunk(audioBytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send(buildAudioFrame(this.sessionId, audioBytes));
  }

  finishSession(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.send(buildFinishSessionFrame(this.sessionId));
    } catch {
      /* ignore */
    }
  }

  finishConnection(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.send(buildFinishConnectionFrame());
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.finishSession();
    this.finishConnection();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}

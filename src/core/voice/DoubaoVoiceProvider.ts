import { Platform } from "react-native";
import { VoiceEventBus } from "./VoiceEventBus";
import type { VoiceProvider } from "./VoiceProvider";
import type { VoiceEventMap, VoiceEventName } from "./types";
import { Agent } from "../agent/Agent";
import { agentWorkspace } from "../agent/AgentWorkspace";
import type { IntentClassifier } from "../agent/IntentClassifier";
import {
  buildAudioFrame,
  buildChatTextQueryFrame,
  buildChatTtsTextFrame,
  buildFinishConnectionFrame,
  buildFinishSessionFrame,
  buildHelloFrame,
  buildStartConnectionFrame,
  buildStartSessionFrame,
  parseDoubaoResponse,
} from "./doubaoProtocol";
import { AudioResponseCache } from "./AudioResponseCache";
import type { DoubaoRuntimeConfig } from "./doubaoConfig";
import { hasValidDoubaoCredentials } from "./doubaoConfig";
import { createAudioCapture } from "../audio/AudioCapture";
import { createAudioPlayer } from "../audio/AudioPlayer";
import type { AudioCapture } from "../audio/AudioCapture";
import type { AudioPlayer } from "../audio/AudioPlayer";

const LOG_PREFIX = "[DoubaoVP]";

export interface DoubaoProviderOptions {
  agent: Agent;
  intentClassifier: IntentClassifier;
  config: DoubaoRuntimeConfig;
  demoUtterance?: string;
  greetingText?: string;
}

export class DoubaoVoiceProvider implements VoiceProvider {
  readonly id = "doubao" as const;
  private readonly events = new VoiceEventBus();
  private demoTimer: ReturnType<typeof setTimeout> | null = null;
  private speakingBackTimer: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocket | null = null;
  private sessionId = "";
  private connected = false;
  private sessionReady = false;
  private useMockMode = false;
  private greetingSent = false;
  private handshakePhase: "idle" | "waitingStartConnection" | "waitingStartSession" | "ready" = "idle";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private audioCapture: AudioCapture | null = null;
  private audioPlayer: AudioPlayer | null = null;
  private removeAudioCallback: (() => void) | null = null;
  private readonly responseCache = new AudioResponseCache();
  private pendingCacheKey: string | null = null;
  private pendingCacheText = "";
  private pendingCacheAudio: Int16Array[] = [];
  private lastClassifiedAsrText = "";
  private pendingAsrText = "";
  private hasRoutedCurrentUtterance = false;
  private bootstrapContextWindow: string[] = [];
  private holdS2SUntilRoute = false;
  private deferredS2SAudio: Int16Array[] = [];
  private deferredS2STexts: string[] = [];
  private pendingAgentTtsText: string | null = null;
  private isSendingChatTtsText = false; // 类似官方的 is_sending_chat_tts_text：发送中丢弃S2S音频

  constructor(private readonly options: DoubaoProviderOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.prepareAgentWorkspace();
    if (!hasValidDoubaoCredentials(this.options.config)) {
      this.useMockMode = true;
      console.log(`${LOG_PREFIX} 豆包鉴权缺失，进入 Mock 模式。`);
      this.events.emit(
        "error",
        "豆包鉴权信息缺失，请设置 HEROS_DOUBAO_APP_ID / HEROS_DOUBAO_ACCESS_KEY。"
      );
      this.events.emit("stage", "listening");
      this.scheduleDemoUtterance();
      return;
    }

    try {
      console.log(`${LOG_PREFIX} 开始连接豆包...`);
      await this.connectDoubao();
      console.log(`${LOG_PREFIX} WebSocket 已连接，等待 Session 就绪...`);

      this.audioCapture = createAudioCapture();
      this.audioPlayer = createAudioPlayer();

      await this.audioCapture.start();
      console.log(`${LOG_PREFIX} 音频采集已启动`);

      this.removeAudioCallback = this.audioCapture.onAudioData((chunk) => {
        void this.sendAudioChunk(chunk);
      });
      this.events.emit("stage", "thinking");
      this.scheduleDemoUtterance();
    } catch (error) {
      this.useMockMode = true;
      const message = error instanceof Error ? error.message : "豆包连接失败";
      console.log(`${LOG_PREFIX} 启动失败: ${message}`);
      this.events.emit("error", message);
      this.events.emit("stage", "listening");
      this.scheduleDemoUtterance();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    console.log(`${LOG_PREFIX} 停止中...`);
    if (this.demoTimer) {
      clearTimeout(this.demoTimer);
      this.demoTimer = null;
    }
    if (this.speakingBackTimer) {
      clearTimeout(this.speakingBackTimer);
      this.speakingBackTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.removeAudioCallback) {
      this.removeAudioCallback();
      this.removeAudioCallback = null;
    }

    if (this.audioCapture) {
      try {
        await this.audioCapture.stop();
      } catch {
        // ignore
      }
      this.audioCapture = null;
    }

    if (this.audioPlayer) {
      try {
        await this.audioPlayer.reset();
      } catch {
        // ignore
      }
      this.audioPlayer = null;
    }

    if (!this.useMockMode) {
      try {
        await this.finishConnection();
      } catch {
        // ignore shutdown errors
      }
    }

    this.sessionReady = false;
    this.handshakePhase = "idle";
    this.greetingSent = false;
    this.pendingCacheKey = null;
    this.pendingCacheText = "";
    this.pendingCacheAudio = [];
    this.holdS2SUntilRoute = false;
    this.deferredS2SAudio = [];
    this.deferredS2STexts = [];
    this.pendingAgentTtsText = null;
    this.events.emit("stage", "idle");
  }

  async speak(text: string): Promise<void> {
    if (!this.useMockMode && this.connected) {
      await this.sendChatTextQuery(text);
      return;
    }

    this.events.emit("stage", "speaking");
    this.events.emit("response", text);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(Math.max(text.length * 20, 400), 1800));
    });
    this.events.emit("stage", "listening");
  }

  on<K extends VoiceEventName>(event: K, listener: VoiceEventMap[K]): () => void {
    return this.events.on(event, listener);
  }

  private scheduleDemoUtterance(): void {
    if (!this.options.demoUtterance) {
      return;
    }

    this.demoTimer = setTimeout(() => {
      void this.handleUtterance(this.options.demoUtterance ?? "");
    }, 1400);
  }

  private async handleUtterance(text: string): Promise<void> {
    try {
      if (!this.useMockMode && this.connected) {
        await this.sendChatTextQuery(text);
        return;
      }

      this.events.emit("stage", "thinking");
      this.events.emit("transcript", text);
      const result = await this.options.agent.handleUtterance(text);
      await this.speak(result.reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知语音错误";
      this.events.emit("error", message);
      this.events.emit("stage", "error");
    }
  }

  private async sendAudioChunk(chunk: Int16Array): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.connected || !this.sessionReady) return;

    try {
      this.events.emit("inputLevel", this.computeAudioLevel(chunk));
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const frame = buildAudioFrame(this.sessionId, bytes);
      this.ws.send(frame.buffer as ArrayBuffer);
    } catch {
      // Ignore transient send errors during audio streaming
    }
  }

  private async connectDoubao(): Promise<void> {
    this.sessionId = this.generateSessionId();
    const headers = {
      "X-Api-App-ID": this.options.config.appId,
      "X-Api-Access-Key": this.options.config.accessKey,
      "X-Api-Resource-Id": this.options.config.resourceId,
      "X-Api-App-Key": this.options.config.appKey,
      "X-Api-Connect-Id": this.generateSessionId(),
    };

    await new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      if (Platform.OS === "windows" || Platform.OS === "macos") {
        const DesktopWebSocket = WebSocket as unknown as {
          new (url: string, protocols?: string | string[], options?: unknown): WebSocket;
        };
        ws = new DesktopWebSocket(this.options.config.baseUrl, undefined, { headers });
      } else {
        ws = new WebSocket(this.options.config.baseUrl);
      }

      (ws as unknown as { binaryType?: string }).binaryType = "arraybuffer";
      ws.onopen = () => {
        this.ws = ws;
        this.connected = true;
        this.handshakePhase = "waitingStartConnection";
        void this.startSessionHandshake()
          .then(() => resolve())
          .catch((error) => reject(error));
      };
      ws.onerror = () => {
        reject(new Error("豆包 WebSocket 连接失败"));
      };
      ws.onmessage = (message) => {
        void this.handleWsMessage(message.data).catch((error) => {
          const msg = error instanceof Error ? error.message : "豆包消息解析失败";
          console.log(`${LOG_PREFIX} onmessage 异常: ${msg}`);
          this.events.emit("error", msg);
          this.events.emit("stage", "error");
        });
      };
      ws.onclose = (event) => {
        this.connected = false;
        this.sessionReady = false;
        this.handshakePhase = "idle";
        console.log(`${LOG_PREFIX} WebSocket 关闭 code=${event.code}`);
      };
    });
  }

  private async startSessionHandshake(): Promise<void> {
    this.sendBinary(buildStartConnectionFrame());
    console.log(`${LOG_PREFIX} StartConnection 握手帧已发送`);
  }

  private async finishConnection(): Promise<void> {
    if (!this.ws || !this.connected) {
      return;
    }

    try {
      this.sendBinary(buildFinishSessionFrame(this.sessionId));
      this.sendBinary(buildFinishConnectionFrame());
    } catch {
      // ignore shutdown errors
    }

    try {
      this.ws.close();
    } catch {
      // ignore close errors
    }
    this.ws = null;
    this.connected = false;
    this.sessionReady = false;
  }

  private sendBinary(bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("豆包连接未就绪");
    }
    this.ws.send(bytes.buffer as ArrayBuffer);
  }

  private async sendChatTextQuery(text: string): Promise<void> {
    this.events.emit("stage", "thinking");
    this.events.emit("transcript", text);
    console.log(`${LOG_PREFIX} 意图分类输入(text): ${text}`);
    const classification = await this.options.intentClassifier.classify(text, this.bootstrapContextWindow);
    console.log(
      `${LOG_PREFIX} 意图分类(text) => label=${classification.label}, confidence=${classification.confidence.toFixed(
        2
      )}, reason=${classification.reason}`
    );
    const cacheKey = this.buildCacheKey(text);
    if (classification.label === "chitchat") {
      const cached = this.responseCache.get(cacheKey);
      if (cached) {
        console.log(`${LOG_PREFIX} 命中语音缓存，直接回放`);
        await this.playCachedResponse(cached.text, cached.audioChunks);
        return;
      }
      this.pendingCacheKey = cacheKey;
      this.pendingCacheText = "";
      this.pendingCacheAudio = [];
    } else {
      // 对应流程图中的 E -> 丢弃缓存 -> J
      this.responseCache.clear();
      this.pendingCacheKey = null;
      this.pendingCacheText = "";
      this.pendingCacheAudio = [];
    }

    if (classification.label === "intent") {
      const agentResult = await this.options.agent.handleUtterance(text);
      console.log(`${LOG_PREFIX} Agent 处理(text) => ${agentResult.reply}`);
      this.sendAgentReply(agentResult.reply);
      return;
    }
    this.sendBinary(buildChatTextQueryFrame(this.sessionId, text));
  }

  private async handleWsMessage(data: unknown): Promise<void> {
    const raw = this.toUint8Array(data);
    if (!raw) {
      return;
    }
    const parsed = parseDoubaoResponse(raw);
    if (!parsed) {
      return;
    }

    // 调试：记录所有非纯音频的服务端消息
    if (!(parsed.messageType === "SERVER_ACK" && parsed.payloadRaw && parsed.payloadRaw.length > 0)) {
      console.log(`${LOG_PREFIX} ← event=${parsed.event} type=${parsed.messageType}`);
    }

    if (parsed.messageType === "SERVER_ERROR") {
      const errDetail = JSON.stringify(parsed.payload ?? parsed.code);
      console.log(`${LOG_PREFIX} 服务端错误: ${errDetail}`);
      if (
        this.pendingAgentTtsText &&
        /(50[02]|chatttstext|event)/i.test(errDetail) &&
        this.connected &&
        this.sessionReady
      ) {
        const fallbackText = this.pendingAgentTtsText;
        this.pendingAgentTtsText = null;
        console.log(`${LOG_PREFIX} ChatTTSText 不可用，降级回 ChatTextQuery`);
        this.sendBinary(buildChatTextQueryFrame(this.sessionId, fallbackText));
        return;
      }
      if (errDetail.includes("DialogAudioIdleTimeoutError")) {
        this.events.emit("stage", "listening");
        this.scheduleReconnect();
        return;
      }
      this.events.emit("error", `豆包服务错误: ${errDetail}`);
      this.events.emit("stage", "error");
      this.pendingCacheKey = null;
      this.pendingCacheText = "";
      this.pendingCacheAudio = [];
      this.holdS2SUntilRoute = false;
      this.deferredS2SAudio = [];
      this.deferredS2STexts = [];
      this.pendingAgentTtsText = null;
      return;
    }

    if (this.handshakePhase === "waitingStartConnection") {
      this.handshakePhase = "waitingStartSession";
      console.log(`${LOG_PREFIX} StartConnection 已响应，发送 StartSession`);
      const sessionPayload = {
        asr: {
          extra: {
            end_smooth_window_ms: 1500,
          },
        },
        tts: {
          speaker: this.options.config.speaker,
          audio_config: {
            channel: 1,
            format: "pcm",
            sample_rate: 24000,
          },
        },
        dialog: {
          bot_name: this.options.config.botName,
          system_role: this.options.config.systemRole,
          speaking_style: this.options.config.speakingStyle,
          location: { city: "北京" },
          greeting: this.options.greetingText ?? undefined,
          extra: {
            strict_audit: false,
            audit_response: "支持客户自定义安全审核回复话术。",
            recv_timeout: 10,
            input_mod: "audio",
          },
        },
      };
      this.sendBinary(buildStartSessionFrame(this.sessionId, sessionPayload));
      return;
    }

    if (this.handshakePhase === "waitingStartSession") {
      this.handshakePhase = "ready";
      this.sessionReady = true;
      console.log(`${LOG_PREFIX} StartSession 已响应，Session 就绪`);
      this.events.emit("stage", "listening");
      if (!this.greetingSent && this.options.greetingText) {
        this.greetingSent = true;
        console.log(`${LOG_PREFIX} 发送开场问候(300) → ${this.options.greetingText}`);
        this.sendBinary(buildHelloFrame(this.sessionId, this.options.greetingText));
      }
    }

    if (parsed.messageType === "SERVER_ACK") {
      this.sessionReady = true;
      if (parsed.payloadRaw && parsed.payloadRaw.length > 0) {
        // 官方的 is_sending_chat_tts_text：发送 ChatTtsText 期间丢弃所有 S2S 音频
        if (this.isSendingChatTtsText) {
          console.log(`${LOG_PREFIX} TTS音频丢弃(ChatTtsText发送中, event=${parsed.event}) size=${parsed.payloadRaw.length}`);
          return;
        }
        if (this.shouldDeferS2SOutput()) {
          console.log(`${LOG_PREFIX} TTS音频延迟(event=${parsed.event}) size=${parsed.payloadRaw.length}`);
          this.deferS2SAudio(parsed.payloadRaw);
        } else {
          console.log(`${LOG_PREFIX} TTS音频播放(event=${parsed.event}) size=${parsed.payloadRaw.length}`);
          await this.playResponseAudio(parsed.payloadRaw);
          this.events.emit("stage", "speaking");
          if (this.speakingBackTimer) {
            clearTimeout(this.speakingBackTimer);
          }
          this.speakingBackTimer = setTimeout(() => {
            this.events.emit("stage", "listening");
          }, 900);
        }
      }
      return;
    }

    // SERVER_FULL_RESPONSE — may contain audio (TTS), text (ASR), or both
    const hasAudio = parsed.payloadRaw && parsed.payloadRaw.length > 0;

    if (hasAudio) {
      if (this.shouldDeferS2SOutput()) {
        console.log(`${LOG_PREFIX} FULL_RESP音频延迟(event=${parsed.event}) size=${parsed.payloadRaw!.length}`);
        this.deferS2SAudio(parsed.payloadRaw!);
      } else {
        console.log(`${LOG_PREFIX} FULL_RESP音频播放(event=${parsed.event}) size=${parsed.payloadRaw!.length}`);
        console.log(`${LOG_PREFIX} 收到 TTS 音频 ${parsed.payloadRaw!.length} bytes, 开始播放`);
        await this.playResponseAudio(parsed.payloadRaw!);
        this.events.emit("stage", "speaking");
        if (this.speakingBackTimer) {
          clearTimeout(this.speakingBackTimer);
        }
        this.speakingBackTimer = setTimeout(() => {
          this.events.emit("stage", "listening");
        }, 900);
      }
    }

    const payloadText = this.deepFindText(parsed.payload);
    if (payloadText && this.shouldLogText(payloadText)) {
      console.log(`${LOG_PREFIX} 收到文本: ${payloadText}`);
      this.pendingAgentTtsText = null;
      if (this.shouldDeferS2SOutput()) {
        this.deferredS2STexts.push(payloadText);
      } else {
        this.events.emit("response", payloadText);
        if (this.pendingCacheKey && !this.isLikelyOpaqueId(payloadText)) {
          this.pendingCacheText = payloadText;
        }
      }
    }

    const asrResponse = this.extractAsrResponse(parsed.payload);
    const asrText = asrResponse?.text ?? this.deepFindAsrText(parsed.payload);
    const asrEvent = this.detectAsrEvent(parsed);
    if (asrEvent === "ASR_INFO") {
      // 用户开始说话，优先打断播报并进入听写阶段
      if (this.audioPlayer) {
        try {
          await this.audioPlayer.stop();
        } catch {
          // ignore stop errors
        }
      }
      this.events.emit("stage", "listening");
      this.pendingAsrText = "";
      this.hasRoutedCurrentUtterance = false;
      this.holdS2SUntilRoute = true;
      this.deferredS2SAudio = [];
      this.deferredS2STexts = [];
      if (asrText && !this.isLikelyProtocolNoise(asrText)) {
        this.pendingAsrText = asrText;
        console.log(`${LOG_PREFIX} ${asrEvent} (start speaking detected)`);
      }
    } else if (asrEvent === "ASR_RESPONSE" && asrText) {
      if (!this.isLikelyProtocolNoise(asrText)) {
        // 防御：ASR_INFO 可能未被可靠检测，在一轮新语音开始时也启用 S2S 拦截
        if (!this.hasRoutedCurrentUtterance) {
          this.holdS2SUntilRoute = true;
        }
        this.pendingAsrText = asrText;
        const interim = asrResponse?.isInterim ?? false;
        console.log(`${LOG_PREFIX} ${asrEvent}: ${asrText} (is_interim=${String(interim)})`);
        if (!interim && !this.hasRoutedCurrentUtterance && asrText !== this.lastClassifiedAsrText) {
          this.lastClassifiedAsrText = asrText;
          this.hasRoutedCurrentUtterance = true;
          void this.classifyAndRouteFromAsr(asrText, "asr-response");
        }
      }
    }
    if (asrEvent === "ASR_ENDED") {
      const finalAsrText = (asrText || this.pendingAsrText).trim();
      if (
        finalAsrText &&
        !this.isLikelyProtocolNoise(finalAsrText) &&
        !this.hasRoutedCurrentUtterance &&
        finalAsrText !== this.lastClassifiedAsrText
      ) {
        this.lastClassifiedAsrText = finalAsrText;
        this.pendingAsrText = finalAsrText;
        this.hasRoutedCurrentUtterance = true;
        void this.classifyAndRouteFromAsr(finalAsrText, "asr-ended");
      }
    }

    if (!this.sessionReady) {
      this.sessionReady = true;
      console.log(`${LOG_PREFIX} Session 已就绪 (via event ${parsed.event})`);
    }

    if (parsed.event === 350) {
      const payload = parsed.payload as Record<string, unknown> | undefined;
      const ttsType = payload?.tts_type ?? "unknown";
      console.log(`${LOG_PREFIX} TTSSentenceStart tts_type=${ttsType} isSending=${this.isSendingChatTtsText}`);
      // 官方逻辑：收到 chat_tts_text 类型的 TTSSentenceStart 时，清空音频缓冲并放行
      if (this.isSendingChatTtsText && (ttsType === "chat_tts_text" || ttsType === "external_rag")) {
        this.deferredS2SAudio = [];
        this.deferredS2STexts = [];
        this.isSendingChatTtsText = false;
        console.log(`${LOG_PREFIX} ChatTtsText 音频开始，已清空 S2S 缓冲并放行`);
      }
    } else if (parsed.event === 351) {
      console.log(`${LOG_PREFIX} TTSSentenceEnd`);
    } else if (parsed.event === 450) {
      this.events.emit("stage", "listening");
    } else if (parsed.event === 459) {
      this.events.emit("stage", "thinking");
    } else if (parsed.event === 359 || parsed.event === 152 || parsed.event === 153) {
      if (this.pendingCacheKey && this.pendingCacheAudio.length > 0) {
        this.responseCache.set(
          this.pendingCacheKey,
          this.pendingCacheText || "好的。",
          this.pendingCacheAudio
        );
        console.log(`${LOG_PREFIX} 已写入语音缓存 key=${this.pendingCacheKey}`);
      }
      this.pendingCacheKey = null;
      this.pendingCacheText = "";
      this.pendingCacheAudio = [];
      this.pendingAsrText = "";
      this.hasRoutedCurrentUtterance = false;
      this.holdS2SUntilRoute = true;
      this.deferredS2SAudio = [];
      this.deferredS2STexts = [];
      this.pendingAgentTtsText = null;
      this.events.emit("stage", "listening");
    }
  }

  private async playResponseAudio(payloadRaw: Uint8Array): Promise<void> {
    if (!this.audioPlayer) {
      console.log(`${LOG_PREFIX} audioPlayer 未初始化，跳过播放`);
      return;
    }
    if (payloadRaw.length < 2) {
      console.log(`${LOG_PREFIX} payloadRaw 太短 (${payloadRaw.length})，跳过`);
      return;
    }

    const int16Data = new Int16Array(
      payloadRaw.buffer,
      payloadRaw.byteOffset,
      Math.floor(payloadRaw.byteLength / 2)
    );
    if (this.pendingCacheKey && int16Data.length > 0) {
      this.pendingCacheAudio.push(new Int16Array(int16Data));
    }
    this.events.emit("outputLevel", this.computeAudioLevel(int16Data));

    try {
      await this.audioPlayer.play(int16Data);
    } catch (error) {
      console.log(`${LOG_PREFIX} 播放音频响应失败:`, error);
    }
  }

  private async playCachedResponse(text: string, audioChunks: Int16Array[]): Promise<void> {
    this.events.emit("stage", "speaking");
    if (text) {
      this.events.emit("response", text);
    }
    for (const chunk of audioChunks) {
      if (!this.audioPlayer || this.stopped) break;
      this.events.emit("outputLevel", this.computeAudioLevel(chunk));
      try {
        await this.audioPlayer.play(chunk);
      } catch {
        // ignore single chunk failure, continue remaining chunks
      }
    }
    this.events.emit("stage", "listening");
  }

  private computeAudioLevel(samples: Int16Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / samples.length);
    return Math.max(0, Math.min(1, rms * 3.2));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.useMockMode) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectSession();
    }, 500);
  }

  private async reconnectSession(): Promise<void> {
    if (this.stopped || this.useMockMode) {
      return;
    }
    try {
      await this.finishConnection();
    } catch {
      // ignore close race during reconnect
    }
    this.sessionReady = false;
    this.handshakePhase = "idle";
    console.log(`${LOG_PREFIX} Idle timeout 后尝试重连...`);
    await this.connectDoubao();
  }

  private toUint8Array(data: unknown): Uint8Array | null {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  private deepFindText(payload: unknown): string | null {
    if (typeof payload === "string") {
      return payload.trim() ? payload : null;
    }
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const text = this.deepFindText(item);
        if (text) {
          return text;
        }
      }
      return null;
    }
    if (payload && typeof payload === "object") {
      const rec = payload as Record<string, unknown>;
      for (const key of ["asr_text", "text", "content", "answer", "query", "question"]) {
        const text = this.deepFindText(rec[key]);
        if (text) {
          return text;
        }
      }
      for (const value of Object.values(rec)) {
        const text = this.deepFindText(value);
        if (text) {
          return text;
        }
      }
    }
    return null;
  }

  private isLikelyOpaqueId(text: string): boolean {
    return /^[0-9a-fA-F-]{16,}$/.test(text.trim());
  }

  private buildCacheKey(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private deepFindAsrText(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const walk = (node: unknown): string | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = walk(item);
          if (found) return found;
        }
        return null;
      }
      const rec = node as Record<string, unknown>;
      const direct = rec.asr_text;
      if (typeof direct === "string" && direct.trim()) {
        return direct.trim();
      }
      for (const value of Object.values(rec)) {
        const found = walk(value);
        if (found) return found;
      }
      return null;
    };
    return walk(payload);
  }

  private async classifyAndRouteFromAsr(
    asrText: string,
    source: "asr-response" | "asr-ended"
  ): Promise<void> {
    console.log(`${LOG_PREFIX} 意图分类输入(${source}): ${asrText}`);
    const classification = await this.options.intentClassifier.classify(
      asrText,
      this.bootstrapContextWindow
    );
    console.log(
      `${LOG_PREFIX} 意图分类(${source}) => label=${classification.label}, confidence=${classification.confidence.toFixed(
        2
      )}, reason=${classification.reason}`
    );
    this.holdS2SUntilRoute = false;

    if (classification.label === "intent") {
      console.log(`${LOG_PREFIX} D=是 -> 走 Agent 处理分流 (Agent结果播报)`);
      this.responseCache.clear();
      this.pendingCacheKey = null;
      this.pendingCacheText = "";
      this.pendingCacheAudio = [];
      // 放弃分类前积压的 S2S 数据
      this.deferredS2SAudio = [];
      this.deferredS2STexts = [];
      // 延长门控：Agent 执行期间 S2S 仍可能持续到达，继续拦截
      this.holdS2SUntilRoute = true;
      const agentResult = await this.options.agent.handleUtterance(asrText);

      // ★ 发送 ChatTtsText 前彻底清空缓存和状态
      // 1. 重置 audio player
      if (this.audioPlayer) {
        try {
          await this.audioPlayer.reset();
        } catch {
          // ignore
        }
      }
      // 2. 再次清空 Agent 执行期间积压的 S2S 数据
      this.deferredS2SAudio = [];
      this.deferredS2STexts = [];
      this.pendingCacheKey = null;
      this.pendingCacheText = "";
      this.pendingCacheAudio = [];
      // 3. 释放门控，让 ChatTtsText 的 TTS 音频能直接播放
      this.holdS2SUntilRoute = false;
      this.pendingAgentTtsText = null;

      console.log(`${LOG_PREFIX} Agent 处理(${source}) => ${agentResult.reply}`);
      this.events.emit("stage", "thinking");
      this.sendAgentReply(agentResult.reply);
      return;
    }

    // chitchat / fallthrough：释放门控，回放积压的 S2S 输出
    this.holdS2SUntilRoute = false;
    const cacheKey = this.buildCacheKey(asrText);
    this.pendingCacheKey = cacheKey;
    this.pendingCacheText = "";
    this.pendingCacheAudio = [];
    await this.flushDeferredS2SOutput();
  }

  private detectAsrEvent(parsed: { event?: number; payload?: unknown }): "ASR_INFO" | "ASR_RESPONSE" | "ASR_ENDED" | null {
    const event = parsed.event;
    if (event === 451) {
      const payload = parsed.payload;
      if (payload && typeof payload === "object") {
        const rec = payload as Record<string, unknown>;
        if (typeof rec.question_id === "string" && !Array.isArray(rec.results)) {
          return "ASR_INFO";
        }
        if (Array.isArray(rec.results)) {
          return "ASR_RESPONSE";
        }
      }
      return "ASR_RESPONSE";
    }
    if (event === 459) {
      return "ASR_ENDED";
    }
    if (event === 460 || event === 452 || event === 453) {
      return "ASR_ENDED";
    }

    const payloadTag = this.deepFindStringField(parsed.payload, [
      "event_name",
      "event",
      "type",
      "asr_event",
    ]);
    if (!payloadTag) return null;
    const normalized = payloadTag.toLowerCase();
    if (normalized.includes("asrended") || normalized.includes("asr_end")) return "ASR_ENDED";
    if (normalized.includes("asrresponse") || normalized.includes("asr_response")) return "ASR_RESPONSE";
    if (normalized.includes("asrinfo") || normalized.includes("asr_info")) return "ASR_INFO";
    const payload = parsed.payload;
    if (payload && typeof payload === "object") {
      const rec = payload as Record<string, unknown>;
      if (typeof rec.question_id === "string" && !Array.isArray(rec.results)) {
        return "ASR_INFO";
      }
      if (Array.isArray(rec.results)) {
        return "ASR_RESPONSE";
      }
      if (Object.keys(rec).length === 0) {
        return "ASR_ENDED";
      }
    }
    return null;
  }

  private isLikelyProtocolNoise(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    if (/^BigASR-BigStream/i.test(t)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f-]+(_\d+_\d+)?$/i.test(t)) return true;
    if (/^chunk[_-]?\d+$/i.test(t)) return true;
    return false;
  }

  private shouldLogText(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (this.isLikelyProtocolNoise(t)) return false;
    if (this.isLikelyOpaqueId(t)) return false;
    if (/^\d{12,}$/.test(t)) return false;
    return true;
  }

  private deepFindStringField(payload: unknown, keys: string[]): string | null {
    const walk = (node: unknown): string | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = walk(item);
          if (found) return found;
        }
        return null;
      }
      const rec = node as Record<string, unknown>;
      for (const key of keys) {
        const value = rec[key];
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
      for (const value of Object.values(rec)) {
        const found = walk(value);
        if (found) return found;
      }
      return null;
    };
    return walk(payload);
  }

  private extractAsrResponse(payload: unknown): { text: string; isInterim: boolean } | null {
    if (!payload || typeof payload !== "object") return null;
    const rec = payload as Record<string, unknown>;
    const results = rec.results;
    if (!Array.isArray(results) || results.length === 0) return null;
    const first = results[0];
    if (!first || typeof first !== "object") return null;
    const firstRec = first as Record<string, unknown>;
    const text = typeof firstRec.text === "string" ? firstRec.text.trim() : "";
    if (!text) return null;
    const isInterim = Boolean(firstRec.is_interim);
    return { text, isInterim };
  }

  private generateSessionId(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const random = Math.floor(Math.random() * 16);
      const value = char === "x" ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  private async prepareAgentWorkspace(): Promise<void> {
    try {
      await agentWorkspace.ensureInitialized();
      this.bootstrapContextWindow = await agentWorkspace.buildBootstrapContextWindow();
      console.log(`${LOG_PREFIX} Agent workspace 已就绪: ${agentWorkspace.getWorkspaceDir()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.log(`${LOG_PREFIX} Agent workspace 初始化失败，继续使用空上下文: ${message}`);
      this.bootstrapContextWindow = [];
    }
  }

  private sendAgentReply(reply: string): void {
    const text = reply.trim();
    if (!text) return;
    this.events.emit("response", text);
    this.pendingAgentTtsText = text;

    // 官方两包流：start → end，期间丢弃 S2S 音频
    this.isSendingChatTtsText = true;
    try {
      const frame1 = buildChatTtsTextFrame(this.sessionId, text, true, false);
      console.log(`${LOG_PREFIX} 发送 ChatTtsText(500) start payload=${text.length}chars frame=${frame1.length}B`);
      this.sendBinary(frame1);

      const frame2 = buildChatTtsTextFrame(this.sessionId, "", false, true);
      console.log(`${LOG_PREFIX} 发送 ChatTtsText(500) end frame=${frame2.length}B`);
      this.sendBinary(frame2);
    } catch (err) {
      this.isSendingChatTtsText = false;
      console.log(`${LOG_PREFIX} ChatTtsText(500) 发送失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private shouldDeferS2SOutput(): boolean {
    return this.holdS2SUntilRoute;
  }

  private deferS2SAudio(payloadRaw: Uint8Array): void {
    if (payloadRaw.length < 2) return;
    const int16Data = new Int16Array(
      payloadRaw.buffer,
      payloadRaw.byteOffset,
      Math.floor(payloadRaw.byteLength / 2)
    );
    if (int16Data.length <= 0) return;
    this.deferredS2SAudio.push(new Int16Array(int16Data));
  }

  private async flushDeferredS2SOutput(): Promise<void> {
    const stagedText = this.deferredS2STexts.length
      ? this.deferredS2STexts[this.deferredS2STexts.length - 1]
      : "";
    const stagedAudio = this.deferredS2SAudio;
    this.deferredS2STexts = [];
    this.deferredS2SAudio = [];

    if (stagedText) {
      this.events.emit("response", stagedText);
      if (this.pendingCacheKey && !this.isLikelyOpaqueId(stagedText)) {
        this.pendingCacheText = stagedText;
      }
    }
    if (!stagedAudio.length || !this.audioPlayer) return;

    this.events.emit("stage", "speaking");
    for (const chunk of stagedAudio) {
      if (this.pendingCacheKey) {
        this.pendingCacheAudio.push(new Int16Array(chunk));
      }
      this.events.emit("outputLevel", this.computeAudioLevel(chunk));
      try {
        await this.audioPlayer.play(chunk);
      } catch {
        // ignore single chunk playback failure
      }
    }
    this.events.emit("stage", "listening");
  }
}

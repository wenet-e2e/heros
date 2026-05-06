# HerOS 技术方案

## 语音层

- 使用豆包端到端语音能力作为核心交互引擎。
- 基于 WebSocket 协议，支持文本输入和音频输入两种模式。

## Agent 层

- 语音驱动 Agent 执行任务。
- MVP 阶段实现提醒任务的意图识别与执行闭环。
- 不实现会话级记忆，仅保留必要的运行态上下文。

## 客户端层

- 基于 React Native + `react-native-macos` + `react-native-windows` 开发。
- 桌面端采用竖向手机比例容器（19.5:9）以统一移动端交互体验。

## 运行时分流

- 用户语音先经 `S2S-ASR` 转文本，再进入意图分类模型。
- 分类结果决定是否需要 Agent 处理：
  - `intent`：进入 Agent，生成 TTS 文本后走 ChatTtsText 合成语音播报。
  - `chitchat`：走豆包端到端语音回复。
- 所有语音结果统一进入单一播报出口，避免双通道同时发声。
- Agent 路径会触发缓存失效，防止过期音频覆盖新结果。

## 核心模块

- 意图分类：`src/core/agent/IntentClassifier.ts`
  - `LLMIntentClassifier` — OpenAI Responses API
  - `ChatCompletionsIntentClassifier` — 标准 Chat Completions API（DeepSeek 兼容）
  - 启发式回退：`src/core/agent/IntentLexicon.ts`
- Agent 实体：`src/core/agent/Agent.ts`
- Agent 运行时（tool-calling 循环，无 session）：`src/core/agent/AgentRuntime.ts`
- Agent 工作区读写与 Bootstrap 加载：`src/core/agent/AgentWorkspace.ts`
- 语音主流程与分流：`src/core/voice/DoubaoVoiceProvider.ts`
- 客户端语音缓存：`src/core/voice/AudioResponseCache.ts`
- 豆包 WebSocket 会话：`src/core/voice/DoubaoSession.ts`
- 豆包协议解析：`src/core/voice/doubaoProtocol.ts`
- 音频工具（SoX 播放/录音）：`src/core/voice/audioUtils.mjs`
- 运行时状态机：`src/hooks/useHerOSRuntime.ts`
- 状态动画：`src/ui/components/StatusOrb.tsx`

## Agent Bootstrap 文件

- 仓库内模板：`docs/agent-bootstrap/AGENTS.md`、`docs/agent-bootstrap/SOUL.md`、`docs/agent-bootstrap/MEMORY.md`
- 运行时目录：`<DocumentDirectoryPath>/agent-workspace/`
- 启动时自动创建并初始化 `AGENTS.md` / `SOUL.md` / `MEMORY.md`，后续 Agent 读写均在运行时目录完成
- `MEMORY.md` 采用结构化 JSON 数据块保存长期记忆，支持增删改查；每条记忆包含 `id`、`createdAt`、`updatedAt`、`content`
- Agent 不引入 session 概念，仅维护长期记忆（`MEMORY.md`）
- 可通过环境变量 `HEROS_AGENT_WORKSPACE_DIR` 覆盖默认运行时目录

## 豆包协议要点

### ChatTtsText（event 500）

直接 TTS 合成，不经过对话系统。要求：

- `input_mod` 设为 `"audio"`
- 先发送真实语音触发 ASR，收到 ASR_ENDED（event 459）后再发送 ChatTtsText
- VAD 需要语音后的静音段来检测 end-of-speech
- 两包流式发送：`{start:true, content:"...", end:false}` + `{start:false, content:"", end:true}`
- 需通过 `tts_type === "chat_tts_text"`（event 350）过滤 TTS 音频，避免播放默认 bot 回复

### 主要 Server Events

| Event | 含义 |
|-------|------|
| 350 | TTSSentenceStart |
| 351 | TTSSentenceEnd |
| 359 | TTSEnded |
| 450 | ASR_INFO |
| 451 | ASR_RESPONSE |
| 459 | ASR_ENDED |
| 550 | CHAT_RESPONSE |

### 协议帧结构

- 4 字节 header + 变长 payload
- Header: `(protocol_version << 4) | header_size`, `(message_type << 4) | flags`, `(serialization << 4) | compression`, reserved
- 支持 GZIP 压缩和 JSON 序列化

## 豆包配置管理

- 凭据统一存储在项目根目录 `.env.local`（已被 `.gitignore` 忽略）。
- 模板文件为 `.env.example`，可复制后填入真实值。
- 可从外部 `doubao_s2s/config.py` 自动抽取：
  - `python3 scripts/extract_doubao_config.py`
  - 默认输入：`/Users/binbzha/Workspace/github/doubao_s2s/config.py`
  - 默认输出：`./.env.local`

## 原生工程初始化（首次）

- macOS：`npx react-native-macos-init --overwrite`（在项目根目录执行）。
- Windows：`npx react-native init-windows --overwrite`（在项目根目录执行）。

## 系统设计文档

- 详细架构、状态机、缓存一致性与异常恢复请见：`docs/system-design.md`
- 文档中的主流程图与本方案的"运行时分流"保持一致，更新时请双向同步。

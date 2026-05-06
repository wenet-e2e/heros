# HerOS

**Sensation and action in every conversation.**

HerOS 是一个灵感来源于电影《HER》的语音交互软件。打开应用即可直接说话，通过自然对话触发系统执行任务。

MVP 聚焦于「语音对话 + 提醒执行」最短闭环：打开即说，无需会话列表，系统在对话中理解提醒意图并创建提醒。

## 功能

- **端到端语音交互** — 基于豆包实时语音对话，覆盖语音输入、理解与语音回复。
- **Agent 驱动任务执行** — 语音驱动 Agent，MVP 支持提醒的创建与确认。
- **极简状态动画** — 主界面仅保留 Listening / Thinking / Speaking 三类状态反馈。
- **双运行模式** — 终端 CLI 和 React Native GUI 共享同一套核心代码。

## 环境要求

- Node.js >= 20（macOS）或 >= 22（Windows）
- npm >= 9
- SoX（终端模式的音频播放/录音，`apt install sox` 或 `brew install sox`）

## 安装

```bash
git clone <repo-url> && cd heros
npm install
```

## 配置

复制环境变量模板并填入真实凭据：

```bash
cp .env.example .env.local
```

编辑 `.env.local`，必填项：

| 变量 | 说明 |
|------|------|
| `HEROS_DOUBAO_APP_ID` | 豆包应用 ID |
| `HEROS_DOUBAO_ACCESS_KEY` | 豆包 Access Key |
| `HEROS_LLM_API_KEY` | LLM API Key（用于意图分类和 Agent） |
| `HEROS_LLM_BASE_URL` | LLM 接口地址（OpenAI / DeepSeek 兼容） |
| `HEROS_LLM_MODEL` | 模型名称，默认 `gpt-4.1-mini` |

## 运行

所有运行模式共享 `src/core/` 下的同一套模块（意图分类、Agent、语音会话、音频工具）。

### 终端模式

适用于开发调试和自动化场景，无需启动 GUI。

```bash
# 完整流水线：文本输入 → 意图分类 → chitchat 语音 / Agent 执行
npm run test:pipeline -- "帮我查一下内存"

# 交互式流水线
npm run test:pipeline -- --interactive

# 豆包端到端语音对话（文本模式）
npm run doubao:text

# 豆包端到端语音对话（音频模式）
npm run doubao:audio

# 文本 Agent 单次执行
npm run agent:text -- "读取 MEMORY.md"

# 文本 Agent 交互模式
npm run agent:text -- --interactive

# ChatTtsText 独立测试
npm run test:chatttstext -- "这是一条测试语音。"
```

### GUI 模式

基于 React Native，支持 macOS 和 Windows 桌面端。

```bash
# macOS — 一键启动（加载 .env.local，重启 Metro，拉起 App）
./start.sh

# Windows — 一键启动 Metro，然后在 Windows 终端中运行 App
./start.sh

# 手动启动
npm run start          # 启动 Metro
npm run macos          # 启动 macOS App
npm run windows        # 启动 Windows App
```

> 首次运行需先生成原生工程，参见 [docs/tech.md](docs/tech.md#原生工程初始化首次)。

## 项目结构

```
heros/
├── src/
│   ├── core/                  # 共享核心模块（终端和 GUI 共用）
│   │   ├── agent/             # 意图分类、Agent 运行时、工作区
│   │   └── voice/             # 豆包会话、协议解析、音频工具
│   ├── hooks/                 # React hooks（运行时状态机等）
│   └── ui/                    # UI 组件（状态动画等）
├── scripts/                   # 终端入口脚本
│   ├── test_pipeline.ts       # 完整流水线测试
│   ├── doubao_cli.mjs         # 豆包端到端语音 CLI
│   ├── run_agent_text.mjs     # Agent 文本入口
│   └── test_chat_tts_text.mjs # ChatTtsText 独立测试
├── docs/
│   ├── tech.md                # 技术方案
│   ├── system-design.md       # 系统设计文档
│   └── agent-bootstrap/       # Agent Bootstrap 模板
├── .env.example               # 环境变量模板
├── start.sh                   # GUI 一键启动脚本
└── whoareyou.wav              # ASR 触发用测试音频
```

## 文档

- [技术方案](docs/tech.md) — 架构、模块映射、协议说明
- [系统设计](docs/system-design.md) — 状态机、缓存一致性、异常恢复

## 非目标（MVP）

- 多任务工具生态、Skill 市场
- 会话历史管理与会话级记忆
- 复杂聊天界面与消息流展示

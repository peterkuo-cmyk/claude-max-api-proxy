# Claude Max API Proxy

**[English](README.md) | 繁體中文**

**把你每月 $200 的 Claude Max 訂閱變成 Telegram/Discord AI 助手 — 搭配 [OpenClaw](https://openclaw.dev) 驅動。**

## 為什麼做這個

用 Claude API 跑 [OpenClaw](https://openclaw.dev) 很燒錢 — 重度使用每個月輕鬆幾百美金。Claude Max（$200/月）雖然無限量，但 Anthropic 限制只能透過網頁 UI 和 Claude Code CLI 使用，不能拿訂閱制去驅動 OpenClaw 這類第三方工具。

這個 Proxy 繞過了這個限制。它 spawn 真正的 Claude Code CLI 作為子程序，在本地開一個 OpenAI 相容的 HTTP API，讓 OpenClaw 可以用你的 Max 訂閱當後端，驅動 Telegram 和 Discord 機器人。

## 方案對比

把 Claude Max 訂閱變成 API 主要有兩種做法。本專案採用 CLI 方案，基於 [Benson Sun 的架構設計](https://x.com/BensonTWN/status/2022718855177736395)。

|  | Session Token Proxy | CLI Proxy（本專案）|
|--|---------------------|-------------------|
| **運作方式** | 從瀏覽器抽取 `sessionKey` cookie，反向代理模擬瀏覽器流量存取 `claude.ai` | Spawn Claude Code CLI 作為子程序，透過 OpenAI 相容 HTTP API 轉接 |
| **設定** | 從瀏覽器複製 cookie，跑 Docker 容器 | `npm install -g`，CLI 認證一次 |
| **被 Ban 風險** | 較高 — Anthropic 能偵測非瀏覽器的流量特徵（user-agent、timing、token consumption）| 較低 — 流量從 Anthropic 自己的 binary 發出，跟正常 CLI 使用無法區分 |
| **Token 更新** | Session token 會過期，需要手動重新抽取 | CLI 自動處理 OAuth refresh |
| **工具呼叫** | 僅聊天，無法執行工具 | 完整 CLI 工具鏈 — Bash、檔案讀寫、網頁搜尋、瀏覽器自動化 |
| **延遲** | 較低 — 直接 HTTP 呼叫 | 較高 — 子程序 spawn + CLI overhead |
| **併發** | 支援多個同時請求 | 每個 CLI 程序同時處理一個請求 |
| **依賴** | Docker / 反向代理 | Node.js + Claude Code CLI |

## 核心功能

### 一個大腦、一份 Context
聊天和程式碼執行共用同一個 Claude Code CLI session。模型可以讀檔、改檔、跑測試、回報結果 — 全部在同一份連續的 context 裡完成，不需要在不同服務之間傳遞上下文。

### 智慧串流 (Smart Streaming)
CLI 在工具呼叫過程中會產生中間輸出 — 思考步驟、命令結果、內部推理。智慧串流會暫存這些內容，只把最終回覆轉發給客戶端。

```
沒有智慧串流：
  "讓我查一下..."                    ← 洩漏給客戶端
  [工具呼叫: Bash echo hello]       ← 洩漏給客戶端
  "結果是: hello"                   ← 實際答案

有智慧串流：
  "結果是: hello"                   ← 只有這個到達客戶端
```

### 無輪數限制
CLI 可以執行任意數量的工具呼叫 — Bash 指令、檔案讀寫、網頁搜尋、瀏覽器自動化。沒有人為的輪數上限，複雜任務可以完整執行到結束。

### 完整支援 OpenClaw Agent 功能
搭配 [OpenClaw](https://openclaw.dev) 使用時，這個 Proxy 支援所有原生 Agent 功能：
- **搜尋網頁** — 搜尋並摘要網頁內容
- **瀏覽器自動化** — Playwright 驅動的 Chrome 控制，支援登入態
- **語音訊息** — Whisper 轉錄輸入，TTS 語音泡泡輸出
- **排程任務** — Cron 定時任務執行
- **子代理** — 產生子 Agent 平行處理工作
- **媒體附件** — 截圖、檔案、音訊以原生 Telegram/Discord 媒體發送

### 對話持久化
對話能跨訊息維持上下文。Proxy 把每個客戶端對話對應到一個 Claude CLI session — 不需要每次都重送完整歷史。

### 超時保護
10 分鐘的活動超時機制捕捉卡住的程序，同時讓長時間執行的任務正常完成。超時觸發時會透過 Telegram 通知你。

## 運作原理

<p align="center">
  <img src="docs/architecture.png" alt="架構圖" width="700" />
</p>

沒有任何第三方伺服器。所有東西都在你的機器上跑。Request 從 Anthropic 自己的 Binary 出去 — 跟你坐在 Terminal 前面打字完全一樣。

## 快速開始

### 前置需求

1. **Claude Max 訂閱**（$200/月）— [在此訂閱](https://claude.ai/settings/billing)
2. **Claude Code CLI** 已安裝且已認證：
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

### 安裝與執行

```bash
npm install -g claude-max-api-proxy
claude-max-api   # 啟動於 http://localhost:3456
```

### 測試

```bash
# 健康檢查
curl http://localhost:3456/health

# 聊天（串流）
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": true
  }'
```

### macOS 開機自動啟動

建立 `~/Library/LaunchAgents/com.claude-max-api.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.claude-max-api</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>/opt/homebrew/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>/Users/YOUR_USERNAME</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <!-- 選用：超時通知 -->
      <key>TELEGRAM_NOTIFY_ID</key>
      <string>YOUR_TELEGRAM_USER_ID</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/claude-max-api.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-max-api.err.log</string>
  </dict>
</plist>
```

然後載入：
```bash
launchctl load ~/Library/LaunchAgents/com.claude-max-api.plist
```

## 設定

### 環境變數

| 變數 | 必填 | 說明 |
|------|------|------|
| `TELEGRAM_NOTIFY_ID` | 否 | 超時通知的 Telegram 使用者 ID |
| `CLAUDE_CODE_OAUTH_TOKEN` | 否 | 明確指定 OAuth token（否則使用 CLI 的 Keychain）|

### 可用模型

| Model ID | 說明 |
|----------|------|
| `claude-opus-4` | Claude Opus 4（最強）|
| `claude-sonnet-4` | Claude Sonnet 4（均衡）|
| `claude-haiku-4` | Claude Haiku 4（最快）|

支援完整模型家族與版本鎖定（例如 `claude-opus-4-5-20251101`）。

## OpenClaw 整合

在你的 `openclaw.json` 中新增為模型提供者：
```json
{
  "models": {
    "providers": {
      "maxproxy": {
        "baseUrl": "http://127.0.0.1:3456/v1",
        "apiKey": "not-needed",
        "api": "openai-completions"
      }
    }
  }
}
```

完整設定請參考 [OpenClaw 文件](https://openclaw.dev)。

## API 端點

| 端點 | 方法 | 說明 |
|------|------|------|
| `/health` | GET | 健康檢查 |
| `/v1/models` | GET | 列出可用模型 |
| `/v1/chat/completions` | POST | 聊天補全（串流與非串流）|

## 架構

```
dist/
├── adapter/
│   ├── openai-to-cli.js   # OpenAI 請求 → CLI prompt + 系統提示詞
│   └── cli-to-openai.js   # CLI 結果 → OpenAI 回應格式
├── subprocess/
│   └── manager.js          # CLI 子程序生命週期與活動超時
├── session/
│   └── manager.js          # 對話 → CLI session 對應
├── server/
│   ├── routes.js            # 智慧串流、SSE、進度通知
│   ├── index.js             # Express 伺服器設定
│   └── standalone.js        # 進入點
└── types/
    └── claude-cli.js        # CLI stream-json 事件型別守衛
```

## 安全性

- **無 Shell 注入** — 使用 Node.js `spawn()`，非 `exec()`
- **無儲存憑證** — 認證由 Claude CLI 的 OS Keychain 處理
- **無寫死的秘密** — 所有敏感設定透過環境變數
- **僅限本機** — 預設綁定 `127.0.0.1`，不對外暴露

## 使用建議

- **不要拿 Opus 跑 heartbeat/cron** — 固定間隔的 request 可能被視為機器流量。排程任務交給輕量模型（Gemini Flash、Haiku）就好，殺雞不用牛刀。
- **注意 weekly token 上限** — 這個 Proxy 不會繞過任何用量限制。如果你的 Claude Code 很少用到 weekly 上限，就有很大的空間可以用。

## 授權條款

MIT

## 致謝

- 原始概念與架構設計來自 [Benson Sun](https://x.com/BensonTWN/status/2022718855177736395) — 本專案是他方案的開源實作，有部分改動
- 初始代碼 fork 自 [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- 智慧串流、Session 管理、OpenClaw 整合由 [Claude Code](https://github.com/anthropics/claude-code) 實作

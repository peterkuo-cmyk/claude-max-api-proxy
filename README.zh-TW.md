# Claude Max API Proxy

**[English](README.md) | 繁體中文**

**把你每月 $200 的 Claude Max 訂閱變成完整的 OpenAI 相容 API — 支援 Agent 工具呼叫、智慧串流、Telegram 機器人整合。**

大多數人花每月 $200 訂閱 Claude Max，卻只能透過網頁 UI 或 Claude Code CLI 使用。這個 Proxy 把你的訂閱解鎖為標準 API，任何 OpenAI 相容的客戶端（聊天機器人、自動化平台、自訂應用）都能使用 — 不需額外費用。

## 解決什麼問題

| 方案 | 月費 | 你得到什麼 |
|------|------|-----------|
| Claude API（按量計費）| ~$50–200+ 依用量 | 完整 API，但很貴 |
| Claude Max 訂閱 | $200 固定 | 只有網頁 UI + CLI |
| **這個 Proxy** | **$0 額外費用**（用你的 Max 訂閱）| **完整 API** |

Anthropic 封鎖了 OAuth token 的第三方 API 使用。但 Claude Code CLI *可以*使用你的訂閱。這個 Proxy 把 CLI 包裝成子程序，對外暴露標準的 OpenAI 相容 HTTP API。

## 核心功能

### 智慧串流 (Smart Streaming)
一般的 proxy 會把所有中間輸出都丟給客戶端 — 工具呼叫的思考過程、內部推理、除錯文字。**智慧串流會暫存每一輪的輸出，只串流最終回覆。** 你的使用者只看到乾淨的答案。

```
沒有智慧串流：
  "讓我查一下..."                    ← 洩漏給客戶端
  [工具呼叫: Bash echo hello]       ← 洩漏給客戶端
  "結果是: hello"                   ← 實際答案

有智慧串流：
  "結果是: hello"                   ← 只有這個到達客戶端
```

### Agent 工具呼叫（無輪數限制）
CLI 模型可以完整使用工具 — Bash、檔案讀寫、網頁搜尋、瀏覽器自動化。不像一般 proxy 把工具呼叫限制在固定次數，這個 proxy 完全移除了輪數限制。複雜的多步驟任務（程式碼生成、資料分析、檔案處理）可以完整執行到結束。

### 對話持久化
對話能跨訊息維持上下文。Proxy 把每個客戶端對話對應到一個 Claude CLI session，模型會記住你們討論的內容 — 不需要每次都重送完整歷史。

### 超時保護與通知
10 分鐘的活動超時機制可以捕捉真正卡住的程序，同時讓長時間執行的任務（下載、建置）正常完成。超時觸發時，會透過 Telegram 通知你，而不是靜默失敗。

### OpenClaw / Telegram 整合
可與 [OpenClaw](https://openclaw.dev) 搭配作為 Telegram 機器人後端：
- **語音訊息** — 接收語音備忘錄，透過 Whisper 轉錄，以 TTS 語音泡泡回覆
- **瀏覽器自動化** — 控制託管的 Chrome 實例執行網頁任務
- **排程任務** — 定時任務執行
- **媒體附件** — 截圖、檔案、音訊以原生 Telegram 媒體發送

## 運作原理

```
你的 App / Telegram Bot / 任何 OpenAI 客戶端
         ↓
    POST /v1/chat/completions（OpenAI 格式）
         ↓
    Claude Max API Proxy（本專案）
         ↓  轉換請求 → CLI 輸入
         ↓  管理 session 和串流
         ↓
    Claude Code CLI（子程序，帶工具）
         ↓  使用你的 Max 訂閱 OAuth
         ↓
    Anthropic API
         ↓
    回應 → 智慧串流過濾 → OpenAI SSE 格式 → 你的 App
```

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

## 搭配常用工具

### OpenClaw（Telegram Bot）

在 `openclaw.json` 中新增為模型提供者：
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

### Python（OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "你好！"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### Continue.dev（VS Code）

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-sonnet-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### 任何 OpenAI 相容客戶端

指向 `http://localhost:3456/v1`，API key 隨意填。Proxy 會忽略 key，直接使用你的 Claude CLI 認證。

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
│   ├── routes.js            # 智慧串流、SSE、超時通知
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

## 授權條款

MIT

## 致謝

- 原始概念來自 [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)（fork 來源）
- 智慧串流、Session 管理、OpenClaw 整合由 [@anthropic-ai/claude-code](https://github.com/anthropics/claude-code) 實作

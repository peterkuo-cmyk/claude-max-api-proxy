# Claude Max API Proxy

**[English](README.md) | 繁體中文**

**用你的 Claude Max 訂閱搭配任何 OpenAI 相容客戶端。**

## 為什麼做這個

Claude Max（$200/月）提供無限量的 Claude 使用，但 Anthropic 限制只能透過網頁 UI 和 Claude Code CLI 使用 — 不能拿你的訂閱去驅動第三方工具。

這個 Proxy 繞過了這個限制。它 spawn 真正的 Claude Code CLI 作為子程序，在本地開一個 OpenAI 相容的 HTTP API。任何支援 OpenAI chat completions 協議的客戶端都可以用你的 Max 訂閱當後端 — 包括 [OpenClaw](https://openclaw.dev) 的 Telegram/Discord 機器人。

## 運作原理

```
┌─────────────┐     HTTP      ┌──────────────────┐    spawn()    ┌───────────────┐
│  任何 OpenAI  │ ──────────▶ │  Claude Max API   │ ──────────▶ │  Claude Code   │
│  相容客戶端   │ ◀────────── │  Proxy (Express)  │ ◀────────── │  CLI (--print) │
│              │   SSE/JSON   │  localhost:3456   │  stream-json │               │
└─────────────┘               └──────────────────┘              └───────────────┘
```

沒有任何第三方伺服器。所有東西都在你的機器上跑。Request 從 Anthropic 自己的 CLI Binary 出去 — 跟你坐在 Terminal 前面打字完全一樣。

## 核心功能

- **OpenAI 相容 API** — 任何支援 `POST /v1/chat/completions` 的客戶端都可以直接用
- **串流與非串流** — 完整 SSE 串流支援，直接轉發每個 delta
- **對話持久化** — 透過 CLI session resume，對話能跨訊息維持上下文
- **無輪數限制** — CLI 可以執行任意多次工具呼叫，複雜任務完整跑完
- **活動超時** — 10 分鐘無活動看門狗，捕捉卡住的程序，同時讓長時間任務正常完成
- **Telegram 進度通知** — 即時顯示正在執行的工具（選用）
- **無原生依賴** — 純 JS，使用 `child_process.spawn()` 搭配 piped stdio 和 `--output-format stream-json`

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

## 從原始碼編譯

專案附帶完整的 TypeScript 原始碼，位於 `src/`。

```bash
git clone https://github.com/GodYeh/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build    # 編譯 src/ → dist/
npm run start    # 啟動伺服器
```

## 設定

### 環境變數

| 變數 | 必填 | 說明 |
|------|------|------|
| `TELEGRAM_NOTIFY_ID` | 否 | 超時通知的 Telegram 使用者 ID |
| `DEBUG` | 否 | 設定任意值以啟用 request logging |

### 可用模型

| Model ID | 說明 |
|----------|------|
| `claude-opus-4` | Claude Opus（最強）|
| `claude-sonnet-4` | Claude Sonnet（均衡）|
| `claude-haiku-4` | Claude Haiku（最快）|

支援完整模型家族與版本鎖定（例如 `claude-opus-4-5-20251101`、`claude-sonnet-4-20250514`）。

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

搭配 [OpenClaw](https://openclaw.dev) 使用時，支援所有原生 Agent 功能：網頁搜尋、瀏覽器自動化、語音訊息、排程任務、媒體附件等。

## API 端點

| 端點 | 方法 | 說明 |
|------|------|------|
| `/health` | GET | 健康檢查 |
| `/v1/models` | GET | 列出可用模型 |
| `/v1/chat/completions` | POST | 聊天補全（串流與非串流）|

## 專案結構

```
src/
├── adapter/
│   ├── openai-to-cli.ts    # OpenAI 請求 → CLI prompt + 系統提示詞
│   └── cli-to-openai.ts    # CLI JSON stream → OpenAI 回應格式
├── subprocess/
│   └── manager.ts           # CLI 子程序生命週期與活動超時
├── session/
│   └── manager.ts           # 對話 → CLI session 對應
├── server/
│   ├── routes.ts             # SSE 串流、進度通知
│   ├── index.ts              # Express 伺服器設定
│   └── standalone.ts         # 進入點
└── types/
    ├── openai.ts             # OpenAI API 型別定義
    └── claude-cli.ts         # CLI stream-json 事件型別
```

## 安全性

- **無 Shell 注入** — 使用 Node.js `spawn()`，非 `exec()`
- **無儲存憑證** — 認證由 Claude CLI 的 OS Keychain 處理
- **無寫死的秘密** — 所有敏感設定透過環境變數或外部設定檔
- **僅限本機** — 預設綁定 `127.0.0.1`，不對外暴露

## 使用建議

- **不要拿 Opus 跑 heartbeat/cron** — 固定間隔的 request 可能被視為機器流量。排程任務交給輕量模型就好。
- **注意 weekly token 上限** — 這個 Proxy 不會繞過任何用量限制。如果你的 Claude Code 很少用到 weekly 上限，就有很大的空間可以用。

## 授權條款

MIT

## 致謝

- 初始代碼基於 [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- Session 管理、串流、OpenClaw 整合由 [Claude Code](https://github.com/anthropics/claude-code) 實作

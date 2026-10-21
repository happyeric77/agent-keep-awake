# Herdr Keep Awake

在 Herdr agent 或 OpenCode 背景 session 執行工作時，防止您的 Mac 進入休眠。

> **僅支援 macOS。** 本外掛依賴 macOS 內建的 `caffeinate`。
> 未來可能增加 Linux (`systemd-inhibit`) 與 Windows (`SetThreadExecutionState`) 支援——歡迎提交 Pull Request。

需要 Node.js 18+。零 npm 相依性。

## 運作原理

啟動勾點（startup hook）會產生一個輕量守護進程（daemon）。守護進程每 15 秒檢查兩個獨立的來源：
1. **Herdr 窗格：** 執行 `herdr pane list`（帶有執行逾時上限）以檢查是否有任何窗格回報 `agent_status: working`。
2. **OpenCode sessions：** 檢查活躍的 OpenCode 實例，確認是否有處於活躍執行消耗（active execution drain，即 `running`）狀態的背景或前景 session。

若**任一**來源處於活躍狀態（邏輯 OR），守護進程便會維持 `caffeinate -i -s -d` 運行——防止系統休眠並保持螢幕開啟。當所有 Herdr agent 與 OpenCode session 皆轉為閒置時，`caffeinate` 將被停止，Mac 可再次休眠。`blocked` 狀態的窗格與閒置（idle）的 session 會刻意被忽略。

### OpenCode 多 Session 感知

當同一個專案或多個專案中存在多個 OpenCode session 時，Herdr 窗格狀態僅能反映目前聚焦的 session。若 Session A 正在背景執行耗時任務，而您正在檢視處於閒置狀態的 Session B，Keep Awake 會利用 OpenCode v2 整合獨立追蹤 Session A：

- **權威活躍消耗（Authoritative Active Drains）：** OpenCode v2 透過 `GET /api/session/active` 追蹤活躍的前景 session 消耗。在 OpenCode 引擎架構中，這能保證追蹤驅動活躍輪次（active turns）且由行程所持有的前景消耗。當 agent 輪次執行完畢並等待使用者輸入提示詞時，其消耗轉為閒置，並自活躍快照中移除。注意：Retry/backoff 真實執行環境覆蓋尚未驗證；真實 Plugin 載入與 UI A 忙碌 B 閒置之驗收尚未執行。
- **實例隔離（Instance Isolation）：** 每個 OpenCode 外掛實例都會為自己指派唯一的 UUID，並將其活躍 session 寫入 `~/.local/state/herdr-keep-awake/opencode/<instance-uuid>.json`。在同一個 OpenCode 伺服器 PID 下運行的多個專案將保持相互隔離，不會發生狀態衝突。
- **彈性與安全狀態失效（Resilience & Safe State Invalidation）：** 若 OpenCode 行程退出或崩潰，守護進程會偵測行程存活狀態（liveness），並忽略過期或無效 PID 的狀態檔而不會主動刪除（unlink）它們，以避免檔名重複使用時產生競爭條件（race conditions）。外掛退出時負責清理自己的狀態檔，而過期的心跳（預設距上次成功權威快照超過 30 秒）會自動過期，以防止系統無限期保持喚醒。保留的過期或無效檔案會被安全忽略。
- **嚴格快照驗證（Strict Snapshot Validation）：** 心跳僅在取得成功且合法的快照後才會更新。外掛嚴格驗證非包裝映射（unwrapped map）協定（session ID 必須以 `ses` 開頭且 `type: "running"`），拒絕畸形或經包裝（enveloped）的回應，且此時不會更新心跳或狀態。
- **獨立來源與優雅降級（Independent Sources & Graceful Fallback）：** 若 Herdr CLI 在 OpenCode session 活躍執行期間發生連續失敗，keep-awake 仍會維持喚醒狀態。若未安裝 OpenCode 或此外掛，Herdr 窗格偵測仍可維持正常運作。

## 安裝設定

### 1. Herdr 外掛設定

從 GitHub 安裝：

```
herdr plugin install happyeric77/agent-keep-awake
```

或在開發時連結本機目錄：

```
herdr plugin link /path/to/agent-keep-awake
```

建立外掛設定檔：

```
CONFIG_DIR="$(herdr plugin config-dir herdr.keep-awake)"
mkdir -p "$CONFIG_DIR"
cp .env.example "$CONFIG_DIR/.env"
```

確認動作（actions）可見：

```
herdr plugin action list --plugin herdr.keep-awake
```

守護進程會在下一次 Herdr 伺服器啟動時自動啟動（啟動勾點）。
若要在不重啟 Herdr 的情況下啟動它：

```
herdr plugin action invoke herdr.keep-awake.enable
```

### 2. OpenCode v2 外掛設定（選填，用於 OpenCode 多 session 支援）

外掛檔案 `opencode-plugin.mjs` 完全自給自足，無任何外部相依性，亦無需相對路徑引入。

您可以將其註冊在全域 OpenCode 設定檔（`~/.config/opencode/opencode.json`）中：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/path/to/agent-keep-awake/opencode-plugin.mjs"
  ]
}
```

或將其連結／複製到專案的 `.opencode/plugins/` 目錄中：

```bash
mkdir -p .opencode/plugins
ln -s /path/to/agent-keep-awake/opencode-plugin.mjs .opencode/plugins/keep-awake.mjs
```

> **環境變數注意事項：** OpenCode 行程獨立於 Herdr 運行，不會讀取 Herdr 的 `$CONFIG_DIR/.env`。守護進程與 OpenCode 外掛皆預設使用共用目錄 `~/.local/state/herdr-keep-awake/opencode/`。若您自訂了 `OPENCODE_STATE_DIR`，請在 shell 環境中 export 該變數，使 Herdr 與 OpenCode 均能繼承該設定。

## 使用方法

啟用後無需其他操作——守護進程會在 agent 工作時保持 Mac 喚醒，並在工作完成後允許休眠。

切換啟用狀態：

```
herdr plugin action invoke herdr.keep-awake.toggle
```

查看目前模式：

```
cat ~/.local/state/herdr/plugins/herdr.keep-awake/enabled
```

查看守護進程日誌：

```
cat ~/.local/state/herdr/plugins/herdr.keep-awake/daemon.log
```

*(在 Herdr 外部執行或未設定 `HERDR_PLUGIN_STATE_DIR` 時，備用狀態檔位於 `~/.local/state/herdr-keep-awake/`)*

## 按鍵綁定

在 `~/.config/herdr/config.toml` 中綁定切換動作：

```
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr.keep-awake.toggle"
description = "Toggle keep awake"
```

修改設定後重新載入 Herdr，並啟用 toast 以檢視回饋：

```
herdr server reload-config
```

```
[ui.toast]
delivery = "herdr"
```

## 設定選項

所有設定皆自 `$CONFIG_DIR/.env` 讀取：

| 變數 | 預設值 | 說明 |
|---|---|---|
| `KEEP_AWAKE_ENABLED` | `1` | 主要啟用開關 |
| `KEEP_AWAKE_POLL_INTERVAL` | `15` | 輪詢間隔（秒） |
| `KEEP_AWAKE_DISPLAY` | `1` | 工作時是否同時保持螢幕開啟；設為 `0` 僅防止系統休眠（節省電量） |
| `OPENCODE_KEEP_AWAKE_ENABLED` | `1` | 啟用 OpenCode 多 session 追蹤 |
| `OPENCODE_HEARTBEAT_TIMEOUT` | `30` | OpenCode 心跳逾時時間（秒）；逾期心跳將被忽略而不刪除檔案 |
| `OPENCODE_STATE_DIR` | `~/.local/state/herdr-keep-awake/opencode` | OpenCode 狀態檔的明確共用目錄 |
| `HERDR_TIMEOUT_MS` | `5000` | `herdr pane list` 的執行逾時上限（毫秒） |

## 測試

使用 Node.js 執行單元測試與整合測試：

```bash
node --test
```

### 測試範圍與限制

- Node 測試套件涵蓋守護進程子行程生命週期、caffeinate 信號傳遞、行程存活檢查以及 OpenCode 狀態檔解析（共用輔助工具於 `tests/helpers.mjs`）。
- **驗證限制：**
  - Retry/backoff 真實執行環境覆蓋尚未驗證（缺乏已安裝引擎的具體事證能證明 provider retry backoff 會維持活躍 drain 狀態）。
  - 真實外掛載入與 UI A 忙碌 B 閒置之驗收尚未執行。
  - 未宣稱完成完整驗證。

## 限制事項

- macOS 系統實際進入休眠之行為尚未進行實機實驗驗證（目前僅依據 caffeinate 命令列行為與信號管理進行驗證）。
- 使用電池供電時，macOS 會忽略 `caffeinate -s`（系統休眠）——僅防止閒置休眠。此為 Apple 系統設計決策。
- 無論是否執行 `caffeinate`，闔上筆記型電腦螢幕仍會強制休眠。
- 守護進程檢查的是 Herdr 回報的 *agent status* 與 OpenCode session 狀態；若兩個系統皆未將 agent 視為活躍狀態，則無法察覺其進行中的工作。
- OpenCode 追蹤僅觀察 `/api/session/active` 回傳的前景 session 消耗。任何在 OpenCode 行程內輪次執行之外所產生的外部或分離（detached）行程（或未受監控的其他伺服器上的 session）皆無法被呈現。
- 保持螢幕開啟會顯著消耗電池電量（螢幕為最耗電之組件）。若您偏好電池續航力勝於開啟螢幕，請設定 `KEEP_AWAKE_DISPLAY=0`。
- OpenCode 多 session 追蹤需要 OpenCode v2.0+ 並設定 `opencode-plugin.mjs`。

## 授權條款

MIT

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

- **事件驅動狀態追蹤（Event-Driven State Tracking）：** OpenCode v2 外掛透過 Plugin API 之事件訂閱機制（`ctx.event.subscribe`）即時監聽 session 生命週期與執行事件。依據 OpenCode v2.0.26 真實契約，外掛維護最小正確狀態模型（獨立追蹤輪次執行、Shell 執行與 Compaction 狀態）：
  - **輪次執行：** 由 `session.execution.started`、`session.retry.scheduled`、`session.step.started`、`session.step.streamed`、`session.text.started`、`session.text.delta`、`session.reasoning.started`、`session.reasoning.delta`、`session.tool.called`、`session.tool.input.started`、`session.tool.input.delta`、`session.tool.progress` 標記為活躍；由 `session.execution.succeeded`、`session.execution.failed`、`session.execution.interrupted` 標記輪次結束。
  - **Shell 執行：** 由 `session.shell.started` 標記活躍，由 `session.shell.ended`、`session.shell.failed` 標記結束。
  - **Compaction：** 由 `session.compaction.started`、`session.compaction.delta` 標記活躍，由 `session.compaction.ended`、`session.compaction.failed` 標記結束。因 compaction 僅存在於輪次執行中，當執行輪次終止（succeeded/failed/interrupted）時，外掛亦會一併自動清除 compaction 狀態，防止其孤立懸掛。
  - **狀態聚合：** 任一子狀態處於活躍時 session 即為 `running`；僅當所有子狀態皆結束（或收到 `session.deleted`）時才移除。這能確保自動 compaction 或 tool shell 在輪次中結束時不發生「假閒置（fake idle）」，且獨立 compaction/shell 結束後不會永久卡在活躍狀態。追蹤完全獨立於 UI 焦點（pane focus）。
- **實例隔離（Instance Isolation）：** 每個 OpenCode 外掛實例都會為自己指派唯一的 UUID，並將其活躍 session 寫入 `~/.local/state/herdr-keep-awake/opencode/<instance-uuid>.json`。在同一個 OpenCode 伺服器 PID 下運行的多個專案將保持相互隔離，不會發生狀態衝突。若環境缺少 `ctx.event.subscribe`，外掛在建立狀態檔前直接安全退出，不留下任何磁碟檔案。
- **彈性、有限租約與安全失效（Resilience, Finite Lease & Safe Invalidation）：**
  - **首次成功事件定義健康：** 訂閱建立時採延遲疊代驗證，在收到串流發射的第一個實際合法事件（物件且 `type` 為非空字串）前，絕不標記串流健康、不刷新心跳、不重置退避。畸形首筆（例如 `null` 或 `{}`）絕不更新心跳。請注意：`server.connected` 事件不一定由 OpenCode Plugin Bus 發射，外掛不強制依賴特定初始事件，只要收到任何合法 session 或系統事件即視為連線健康。
  - **租約僅用於重連未確認項（防止正常靜默任務被刪）：** 在健康串流下，活躍任務絕不會因時間靜默而被清除。租約機制嚴格僅用於斷線重連後之未確認項目：重連確認時，外掛對斷線前留存之 session 賦予自「確認重連時點」起算的有限租約寬限期（預設 10 秒），而非以舊的 `updatedAt` 立即刪除；一旦收到該 session 的任何新活動事件，即刻清除其未確認租約狀態；若在重連寬限期間完全未收到後續事件，則判定為斷線期間完成之幽靈 session 並自動清理。
  - **無異步競態調和：** 外掛不依賴異步 `session.get` 查詢，避免網路暫時錯誤誤刪任務，並防止串流不健康時寫入心跳。
  - **持續故障安全失效：** 當串流中斷或持續失敗時，外掛停止刷新心跳。當心跳超過逾時時間（預設 30 秒）後，守護進程讀取端自動將狀態視為過期並安全忽略，達成 stale fail-safe。
- **等待互動期間（Permission/Form）之喚醒行為：** 當 OpenCode 在執行過程中要求使用者授權（`permission.asked`）或等待表單互動（`form.created`）時，因所屬執行輪次已開始且尚未結束，外掛會保持該 session 處於活躍狀態以維持喚醒，避免使用者正在思考或查閱文件時系統突然休眠。然而請注意：若使用者離席且長時間未處理互動，系統將持續保持喚醒，直到使用者回應/拒絕或輪次手動中斷為止，外掛不會無故中斷等待。
- **嚴格快照驗證（Strict Snapshot Validation）：** 寫入狀態檔前進行結構與 session 格式驗證（session ID 必須以 `ses` 開頭且標記為 `running`，並防護特殊原型鍵名），拒絕畸形資料或不安全的敏感欄位，且不輸出敏感提示詞或權杖。寫入過程使用基於 UUID 的原子暫存檔寫入與更名，避免競爭條件。同一事件狀態變更與心跳合併為單次寫入。
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

- Node 測試套件涵蓋守護進程子行程生命週期、caffeinate 信號傳遞、行程存活檢查、OpenCode 事件訂閱機制與狀態檔解析（共用輔助工具於 `tests/helpers.mjs`）。
- **驗證限制：**
  - 真實 OpenCode 環境下之長時間背景輪次與實機休眠行為依賴系統 API 與 caffeinate 行程管理，未宣稱完成完整端對端黑箱驗收。

## 限制事項

- macOS 系統實際進入休眠之行為尚未進行實機實驗驗證（目前僅依據 caffeinate 命令列行為與信號管理進行驗證）。
- 使用電池供電時，macOS 會忽略 `caffeinate -s`（系統休眠）——僅防止閒置休眠。此為 Apple 系統設計決策。
- 無論是否執行 `caffeinate`，闔上筆記型電腦螢幕仍會強制休眠。
- 守護進程檢查的是 Herdr 回報的 *agent status* 與 OpenCode session 狀態；若兩個系統皆未將 agent 視為活躍狀態，則無法察覺其進行中的工作。
- OpenCode 追蹤觀察的是外掛事件訂閱所接收到的 session 執行與狀態事件。任何在 OpenCode 行程外分離（detached）執行或未受監控的其他伺服器上的 session 皆無法被呈現。
- **純事件模式失效限制（Pure Event-Driven Failure Limitations）：**
  - **易失性串流無斷線重播：** OpenCode 的 `event.subscribe` 屬易失（volatile）事件串流，斷線期間的事件無法追溯。
  - **斷線長任務重連靜默判定：** 若長任務在斷線前已處於靜默，重連後雖享有自確認重連起算的有限租約寬限（預設 10 秒），但若在寬限期內該任務依然完全未發射任何進度事件，外掛無法確認其是否在斷線中已結束，租約到期後會判定為幽靈任務並清理；系統無法得知重連後毫無新事件之任務的真實存續狀態。
  - **伺服器初始靜默限制：** 若外掛啟動後 OpenCode 完全安靜且無任何事件發射（且環境未發射 `server.connected`），外掛在收到第一筆合法事件前不會刷新心跳；若啟動前已有既有任務正在背景執行但後續毫無事件，純事件模式無法主動向伺服器拉取快照，僅能在收到該 session 的後續進度或生命週期事件時恢復追蹤。
- 在等待使用者互動（如 `permission.asked` 或 `form.created`）期間，session 會維持活躍以防止思考時休眠；若無人值守且未回應，外掛不會主動超時休眠，系統將持續保持喚醒直至手動處理。
- 保持螢幕開啟會顯著消耗電池電量（螢幕為最耗電之組件）。若您偏好電池續航力勝於開啟螢幕，請設定 `KEEP_AWAKE_DISPLAY=0`。
- OpenCode 多 session 追蹤需要 OpenCode v2.0+ 並設定 `opencode-plugin.mjs`。

## 授權條款

MIT

# INCIDENT 2026-11-14 — "delivery is not a wake" 造成 6 小時空轉，但送出的回執看不出來

狀態：**不是 bug（行為與 README A8 / 工具 schema 一致），是一個可修的可觀測性與預設值問題。**
提出者：桌機會話 `session-e04f2b01-3faa-4e24-89ca-e893e6adc42e`（Lead）
對象：筆電會話 `session-8993b073-971e-4100-a20d-1f0cc236ae60`（worker，summersnow）

## 1. 事實（全部可從總線資料複核）

| 時間 (UTC) | 事件 | seq | 方法 | 目標狀態 |
|---|---|---|---|---|
| 13:08:53 | 派工 | 68 | `message.send` | idle |
| 13:17:32 | 派工 | 69 | `message.send` | idle |
| 13:22:26 | 派工 | 70 | `message.send` | idle |
| 19:22:45 | 需求書 | 71 | `session.prompt` | **33 秒後被讀**（`acked_at` 19:23:18Z） |

`read:false` / `acked_at:null` 從 13:08 一直維持到 19:22（**6 小時 13 分**）。三條 `message.send` 的回執都是
`{"ok": true, "delivery": "queued", "receipt": {"seq": N, "queued_at": …, "running": false}}`。

**同一個目標、同一台機器、同一個 token：換 method 之後 33 秒就動了。** 所以瓶頸 100% 在「沒有喚醒」，
不在網路、不在 peer、不在權限（grant 早在 peer 的名片裡給過）。

## 2. 為什麼這是結構問題，不是我的失誤而已

我自己的失誤是清楚的（把 `ok:true` 讀成「它在做了」）。但系統讓這個誤解可以維持 6 小時，因為：

**G1｜回執沒有把「有沒有喚醒」變成欄位。**
`ok:true` + `delivery:"queued"` 是最強訊號，而「沒有喚醒」只出現在一段 `note` 文字裡，
且 `running` 欄位在回執裡是**目標送達當下的狀態**（我收到的兩次都是 `false`/缺省），
不是「我沒有要它跑」的明示。建議：回執加 `woke: boolean`（`message.send` 恆為 false）
與 `target_state: "idle" | "running"`，並在 `woke === false && target_state === "idle"` 時
回一個 `warning` 欄位（不是 error，因為「只投信箱」是合法用法）。

**G2｜沒有「未讀且久未執行」的升級訊號。**
`session_bus_thread` 有 `read:false`，digest 也有 `running with unread: 8993b073(3)`，
但兩者都要**主動去看**。建議：thread/inbox 回一個 `stale` 物件
`{oldest_unread_age_s, target_has_run_since}`，並在 digest 對「未讀 > 1h 且目標期間 0 次執行」單獨列一行。

**G3｜預設值是安靜的那一個。**
`message.send` 是預設，`session.prompt` 要明確指定。對「Lead → worker 派工」這個最常見的場景，
預設值恰好是錯的：**名字叫 send，行為是 drop-in-mailbox**。建議二選一：
(a) 把 `session.prompt` 設為預設，需要純投遞時明寫 `method: "message.send"`；
(b) 保留預設，但對 `target_state === "idle"` 的 `message.send` 強制回 `warning`。

## 3. 不是 bug 的證據

工具 schema 原文（本會話可直接引用）：

> `message.send` (default) only queues the message. `session.prompt` ALSO asks the target host to open a turn.
> Without it the peer may sit on the message indefinitely: delivery is not a wake (see the bus README, A8).

所以**不要**把它當成「訊息掉了」或「喚醒壞了」來修。要修的是**回執與預設值**。

## 4. 建議的驗收（可紅）

- 對一個 idle session 發 `message.send` → 回執必須含 `woke:false` 且有 `warning`；對同一個 session
  發 `session.prompt` → `woke:true`（或 `woke:false` 且 `reason:"already_running"`）。
- 造一個「未讀 90 分鐘、期間目標 0 次執行」的假狀態 → `stale.oldest_unread_age_s > 5400` 且 digest 有那一行。
- 反向控制：目標正在 running 時發 `message.send`，`warning` **不應該**出現（否則就是狼來了）。

## 5. 對本專案的直接影響（記錄，不算本插件的事）

這 6 小時裡，桌機把筆電該做的事做完了（CV 儀器 v0、三渲二素材抽取、材質、貼圖、相機、轉身），
而筆電閒著。修好之後工作模式改成：**桌機提需求 → 筆電評估需求並決定實作**（使用者 2026-11-14 的裁定）。

---

## 6. 追加發現（同日 19:23–19:45Z）：**`acked_at` 不等於「它做了事」**

第一次修好之後（改用 `session.prompt`），目標在 **33 秒內 ack 了 seq 71**（19:23:18Z），
之後 22 分鐘：**沒有回覆、沒有新檔案、`godot=0`**。

我用三個獨立量測確認它不是在跑長回合：

| 量測 | 結果 |
|---|---|
| host 進程 CPU 取樣（pid 16768，6 秒兩次） | **0.016 s / 6 s = 0.3% of one core** |
| 筆電 `godot*` 進程 | 0 |
| `godot-v1` 底下最新檔案 mtime | 03:29（**我**自己跑的），不是它 |
| 它的 `.dsh/sessions` 最新檔案 | **2026-10-20**（26 天前）；`session-8993b073` 甚至沒有 session 檔 |

⇒ **它讀了、ack 了、然後回 idle，什麼都沒做。** 這是與 §1 不同的一個失效模式：
§1 是「沒被喚醒」，§6 是「被喚醒、也 ack 了，但沒有產出」。

### 建議（新增 G4）

- `session_bus_send` 已經有 `reply_to`，但沒有「期待回覆」的語意。建議加 `expect_reply: true`，
  總線據此在 `acked_at` 非 null 但 **`N` 分鐘內沒有對應的 outbound reply** 時，記一筆 `acked_silent`。
- digest 的 `running with unread` 也應該多一欄 `acked_no_reply_age_s`。
- 這一條**不能用「再喚醒一次」解決**：它已經是醒著的。再送只會多一則它會再 ack 一次的信。

### 這條為什麼重要

`acked_at` 在 GAS 側被當成「某個模型讀過」的證據（見 `buswatch` 的設計），
但在自動化調度裡，它被誤讀成「工作已被接手」。**讀與做之間沒有任何訊號**——
而人類看到的 `running:true` 更糟：它在送出當下就回，與實際狀態無關。

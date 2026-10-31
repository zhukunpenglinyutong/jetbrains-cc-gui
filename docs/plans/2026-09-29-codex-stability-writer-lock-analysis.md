# Codex 稳定性问题分析与修复（active-writer 冲突 · 多次打断/执行过久崩溃）

> 分支：`feature/v0.5.9-codex-stability-fixes`（worktree，基于 `feature/v0.5.9-optimize-codex-stability` = 391437c5）
> 依据：2026-09-29 用户实测报错 + WebStorm `idea.log`（10:41–10:45 段）+ 本机复现实验
> 性质：根因分析 + 已实施修复的说明文档

---

## 0. 结论速览

用户现象：**多次打断会崩溃、执行过久会崩溃**，报错：

```
Codex Exec exited with code 1: Reading prompt from stdin...
ERROR codex_core::session::session: failed to initialize thread persistence:
  thread-store conflict: thread <id> already has an active writer
Error: thread/resume: thread/resume failed: ... already has an active writer (code -32600)
```

插件随后提示"会话线程已失效，新建会话即可解决"——**该提示是误诊**（见 §3）。

| 编号 | 根因 | 层 | 严重度 |
|---|---|---|---|
| R1 | 发送无并发守卫：上一回合的 `codex exec` 进程仍存活时，允许再次 spawn 新的 `resume` 同一线程 → 两个 live writer → 冲突 | Java `CodexSDKBridge` | P0 |
| R2 | 打断只杀"入口快照"进程：`interruptChannel` 在进入时取一次 `activeChannelProcesses.get(channelId)`；中断执行窗口（约 300–400ms）内新 send 注册的新进程被 `registerProcess` 覆盖 map 项，成为孤儿（继续运行并持锁） | Java `ProcessManager` + 前端时序 | P0 |
| R3 | 前端 `interruptSession()` **同步**置 `loading=false` 后才异步通知 Java 杀进程；且 `executeMessage` 无 busy 守卫 → 中断窗口内的用户重发/队列排空立即出膛 | webview `useMessageSender` | P0（R1/R2 的触发器） |
| R4 | 队列排空 effect 无单飞门：同一 idle 周期可连发多条（日志实证 10:45:18,547 与 18,649 两次 send 仅隔 100ms） | webview `useMessageQueue` | P1 |
| R5 | 错误分类误导：`errorPatterns.json` 中 `thread/resume` 一律归为"线程已失效，新建会话"，而 active-writer 是本地进程重叠，**线程并未失效**，等待/重发即可 | webview + `codex-utils.js` | P1 |
| R6 | `daemon.js` abort 分支只覆盖 Claude/Grok/ZCode（无 Codex）——Codex 不走 daemon（每消息独立 `channel-manager.js` 进程），目前无害，记录备查 | ai-bridge daemon | P2（无需改） |

## 1. 机制事实（实验确认）

Codex CLI（0.150.1，SDK 内 vendored）在回合运行期间对每个 thread 持有**持久化写者锁**：

- 锁文件：`~/.codex/thread-writer-locks/<thread-uuid>.lock`（0 字节），另有一个长期 `.coordination.lock`。
- 锁本体是 **OS 级文件锁**：进程死亡（含 `taskkill /F /T` 强杀）后 OS 自动释放；**下一个 resume 会自动清理残留锁文件并成功恢复**。
- 本机实验：启动长回合 → 运行中出现 `<thread>.lock` → `taskkill /F /T` 强杀 → 锁文件残留但 resume **成功**且锁目录清空。
- 结论：**"already has an active writer" 仅在存在"活着的 writer"时发生**——即同一个 thread 上有两个并发 `codex exec` 进程。

## 2. 日志实证（WebStorm idea.log，2026-09-29）

时间线（线程 `01a0eb09-d6b3-7061-b4e1-b601a27405d9`，通道 `a962fa3f-...`）：

```
10:44:36,996 Command: ... codex send                      ← 回合 A 运行中
10:45:02,759 [Interrupt] Attempting to interrupt channel
10:45:02,788 Command: ... codex send                      ← 中断开始 29ms 后新 send 已出膛
10:45:03,133 [Interrupt] Successfully terminated           ← 只杀了入口快照的旧进程
10:45:03,172 Command: ... codex send                      ← 又一次 send
10:45:07,016 [Interrupt] Attempting → 07,038 send → 07,380 terminated
10:45:10,572 [Interrupt] Attempting → 10,598 send → 10,964 terminated
10:45:11,000 Command: ... codex send
    ↑ 用户报错时间 02:45:11.045Z == 本地 10:45:11.045 —— 正是这一发的 resume 撞上仍在死的旧 writer
10:45:18,547 Command: ... codex send
10:45:18,649 Command: ... codex send                      ← 100ms 内两次 send（无中断间隔）
10:45:21,119 [Interrupt] Attempting → 21,679 terminated
```

与 R1/R2/R3/R4 完全对应。

## 3. 误诊说明

`webview/src/data/errorPatterns.json` 的 `codexThreadResume` 模式（regex `thread/resume`）把两类不同故障混为一谈：

1. **原生历史找不到**（例如历史目录变化、首次初始化未完成或记录已删除）→ 先检查原生历史与宿主环境；不能据此推断服务端定期清理线程，只有历史确实无法恢复时才建议新建会话；
2. **active-writer 冲突**（本地进程重叠）→ 线程完好，稍候重发即可，"新建会话"是误导（丢失整个会话上下文）。

当前版本已迁移到常驻 app-server；writer 也可能由空闲客户端继续持有，须等待持有者关闭或释放会话。恢复错误的细分、关闭状态的受限重试和处理指引以 `docs/codex/app-server.md` 为准，下文的逐轮 exec 实现仅记录当时的修复。

## 4. 已实施修复

### F1（Java，P0）——发送前终止同通道残留进程 + per-channel 串行化
`src/main/java/com/github/claudecodegui/provider/codex/CodexSDKBridge.java`
- 新增 `channelSendLocks: ConcurrentHashMap<String, ReentrantLock>`（channelId 每会话复用，条目数有界）。
- `sendMessage` 在 `pb.start()` 前：持锁检查 `processManager.getProcess(channelId)`，若仍存活则 `interruptChannel(channelId)`（含等待死亡）后再 spawn。
- 效果：**同一线程任意时刻至多一个 live writer**，从根上消除 writer 冲突（覆盖中断窗口重发、双击 Enter、队列竞态、漏掉的 stream-end 等所有前端时序）。被打断的旧回合以 "User interrupted" 收尾。

### F2（webview，P1）——队列排空单飞门
`webview/src/hooks/useMessageQueue.ts`
- `dispatchedAtRef` 门：一次派发后、`isLoading` 翻 true 前，同一 idle 周期不再派发第二条。
- 若派发后 loading 始终未翻转（执行路径早退），50ms 后重开门并 `gateTick` 触发 effect 重跑——队列永不卡死（保留 80027de2 的"不静默丢弃"语义）。

### F3（daemon + webview，P1）——错误独立分类
- `ai-bridge/services/codex/codex-utils.js` `buildErrorPayload`：识别 `already has an active writer` → 专属文案（"线程被占用…插件现在会自动停止上一回合…无需新建会话"），`details.isThreadWriterConflict` 结构化标记。（该函数无生产调用者，已移除；当前占用分类统一由前端 `errorPatterns.json` 承担，`useCodexCompactionStatus` 保留原始错误交给消息渲染。）
- `errorPatterns.json`：新增 `codexWriterConflict` 模式（regex `already has an active writer`），**置于** `codexThreadResume` 之前（首个匹配生效）。
- 10 个语言文件新增 `errorDiagnostic.codexWriterConflict.{title,intro,reason}`。

### F4（webview，P0，GUI 验证中发现）——迟到的中断回声不得打断新派发回合
GUI 实测（v0.5.8 构建 + 打断后队列排空场景）发现残余缺陷链：

```
Stop → interruptSession 同步置 loading=false → 队列排空派发 Q1（loading=true）
     → Java 杀树完成（~400ms）→ 迟到回声 showLoading(false)（notifyStateChange /
       handleInterruptSession 的显式复位）越过 isStreamingRef 守卫（已被
       interruptSession 清掉）→ loading 被打回 false → 排空 effect 派发 Q2
     → Q2 的发送触发 F1 pre-kill，把正在启动的 Q1 回合杀掉
     → 结果：Q1 变幽灵用户气泡（无回复），仅 Q2 得到回答（GUI 复现截图/日志）
```

修复（`webview/src/utils/streamLifecycle.ts` + 三处接入）：
- `markPendingStreamStart()`：`executeMessage` 派发时打标（`window.__pendingStreamStartAt`）。
- `onStreamStart` / 错误快照（`updateMessages` 含 ERROR 类型，Java 顺序是先快照后 showLoading）/ `onStreamEnd` 清标。
- `showLoading(false)` 与免疫窗口（8s，时间盒防卡死）冲突时忽略回声。
- 回归测试：`streamLifecycleGuard.test.ts`（5 用例：标记生命周期、时间盒过期、回声抑制、错误解除抑制、过期后恢复）。

### F5（webview，P0，用户实测发现）——迟到 onStreamEnd 的 loading 复位绕过免疫窗口 → 打断后重复发送

用户报告"打断之后会重复发送"。日志（13:26:30-31）实证：点一次 Stop 后 ~900ms 内连续 spawn 3+ 条 `codex send`，每条触发一次 pre-kill，把前一条刚注册的进程杀掉。

机制（F4 守卫的两个漏洞叠加）：

```
Stop → interruptSession 清 isStreamingRef（但 streamingTurnIdRef 仍为旧回合的 N>0）
     → loading=false → 队列排空派发 Q1（marker 生效，loading=true）
     → 旧回合被杀 → "forcing stream cleanup" → 迟到 onStreamEnd
        · F4 首版在 onStreamEnd 入口无条件 clearPendingStreamStart() ← 漏洞1
        · 且 streamingTurnIdRef>0 使 handlingMode='full'，完整路径直接
          setLoading(false)，完全绕过 showLoading 的 marker 守卫        ← 漏洞2
     → loading 被打回 false → 排空再次派发 Q2 → Q2 的 pre-kill 杀掉 Q1 的进程
     → Q2 被杀 → 又一条 onStreamEnd 清 marker → …… 自激连锁，队列被连续冲发
```

修复（`streamingCallbacks.ts`）：
- `clearPendingStreamStart()` 从 onStreamEnd 入口移除，改到**真正执行 loading 复位**的分支。
- `'full'` 与 `'minimal'` 两个分支的 loading 复位均受 `suppressLoadingReset = isPendingStreamStartActive()` 保护：marker 活跃期间到来的 onStreamEnd 必然属于旧回合——其气泡收尾照常执行，但**不得认领新派发回合的 loading 状态**。
- 旧回合 echo 处理后设置 `__streamEndProcessedTurnId`，幂等守卫防止重复 finalize。

回归测试：`streamLifecycleGuard.test.ts` 新增"旧回合迟到 onStreamEnd 中途到达时保持 marker 与 loading"用例（6 用例全过）。

## 4.5 GUI 实测结果（v0.5.8 构建，WebStorm 2026.2，Codex / mimo-v2.6-flash low / 全自动）

| 场景 | 修复前（v0.5.7 安装版，用户日志 10:45） | 修复后实测 |
|---|---|---|
| 回合中打断 → 立即重发 | active-writer 冲突，会话报废 | ✅ 同线程 resume 成功（输入 9.2K 上下文保留），0 冲突 |
| 打断后 ~100ms 内重发（预置文字+Stop+Enter 紧凑时序） | 同上 | ✅ 干净恢复（日志：interrupt 21,955 完成 → send 22,174 → 同线程 22,991 resume） |
| 长回合（ping 20-30s）多次循环打断+重发 | 多次打断后必崩 | ✅ 三轮循环无错误 |
| 打断时队列有 2 条待发 | —（F4 前构建：Q1 被 Q2 pre-kill 成幽灵行） | ✅ **F4 后复测通过**：Q1 完整回复（0:02，输入 18.7K）→ Q2 完整回复（0:02，输入 18.7K），按顺序执行、无幽灵行；两次队列派发均触发 F1 pre-kill 兜底并正常恢复 |
| 连续三轮"长命令→打断→立即重发"压测 | 多次打断后必崩 | ✅ R1/S1/R2/S2/R3/S3 全部在同一线程 01a0eb3d 完成，S1-S3 均有完整回复（0:02-0:04）；2 次 pre-kill WARN 均正常兜底；锁目录全程清空、无孤儿 codex.exe |
| 全程锁目录/进程 | 冲突时双 writer | ✅ 每轮结束后 `~/.codex/thread-writer-locks/` 清空、无孤儿 codex.exe |

注：GUI 自动化在测试中途从 ZCode CUA 通道切换为 PowerShell/Win32 输入（截图经 Read 工具核验），测试流程与判定标准不变。

### F1 的良性边界（压测中观察到，记录备查）
队列/压测日志中 2 次 pre-kill WARN 命中的是**上一回合已完成流式输出、node 进程正处于自然退出收尾窗口**（毫秒级）的情况。此时流内容已全部读出、结果完整，pre-kill 只是加速了进程回收；若未来出现极端时序导致结果未读即被杀，该回合会以 "User interrupted" 收尾（不会产生 writer 冲突），属可接受的降级。


## 5. 测试

- `ai-bridge/services/codex/codex-utils.test.js`：新增 writer-conflict 分类断言（7/7 通过）。
- `webview/src/hooks/useMessageQueue.test.ts`：新增"执行路径未翻 loading 时同一周期只派发一条"用例。
- Java 侧随 `buildPlugin` 编译验证 + WebStorm 实测（选 Codex → 多次打断 + 长执行 + 队列连发）。

## 6. 遗留与备查

- **watchdog**：`CODEX_NO_OUTPUT_TIMEOUT_MS = 10min` 无输出即杀树（设计如此：允许长流式回合，只防"完全静默"）。长静默工具调用（如大型安装）仍会被判死，属既定行为；F1 保证其后重发干净。如需放宽另开议题。
- **`maxTurns: 200`**：SDK 硬上限，超限回合终止（已有 fallback 文案）。
- **孤儿 writer 的自然收敛**：F1 之前，中断窗口漏杀的进程会跑完自己的回合后自然退出并释放锁（不会永久中毒）；F1 之后该窗口本身被消除。
- R6：daemon abort 不涉及 Codex，无需改动。

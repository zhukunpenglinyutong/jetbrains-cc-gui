# 首个可见 Tab 历史内容不显示：OnPaint 帧栅栏修复

> 首次记录：2026-08-06
>
> 更新：2026-08-07
>
> 关联问题：#1592
>
> 当前状态：实现与审核已完成；R18 已通过 IDEA 2025.2 多项目、多轮重启及休眠唤醒实机验证，首个可见 Tab 稳定发布完整历史，普通 Tab 切换未再观察到布局抖动

## 1. 问题表现与已确认事实

IDE 启动并恢复多个 CC GUI Tab 时，首个可见 Tab 偶尔只显示 Logo、输入框等基础框架，历史区域为空或仅绘制一部分。鼠标经过只能恢复局部区域，调整窗口尺寸或切换 Tab 后再切回通常可以完整恢复。

日志与实机操作共同确认：

- Java 已成功读取历史并调用 `updateMessages`；
- React state 和 DOM 已包含历史内容；
- 切换 Tab 恢复前没有新的 history query、`updateMessages`、reload 或 recreate；
- hover 只恢复局部，而真实 resize/Tab remap 恢复全页。

因此本问题不是会话数据丢失，而是 Chromium/JCEF OSR 的完整帧没有可靠发布到 JetBrains backing image。

## 2. OSR 的真实完成链路

以下阶段彼此独立，不能互相替代：

```text
React DOM commit
    ↓
Chromium style/layout/compositor
    ↓
CefRenderHandler.OnPaint / onPaintWithSharedMem
    ↓
JetBrains 默认 OSR handler 更新 backing image
    ↓
Swing JBCefOsrComponent.paintComponent()
```

几个容易混淆的操作：

- `requestAnimationFrame()` 只提供浏览器绘制机会，不证明 `OnPaint` 已到达；
- `wasResized()` 只发出异步 resize 通知；相同 bounds/screen-info 会在 CEF 122 中短路，不能作为 repaint/damage API；
- `markCompletelyDirty()`、`repaint()`、`paintImmediately()` 只能重画当前 backing image；
- `notifyScreenInfoChanged()` 更新屏幕和缩放信息，不是内容 invalidation；
- `onLoadEnd`、`frontend_ready` 和 history callback 都不代表首帧已经显示。

## 3. 早期方案与弯路

### 3.1 hide/show 与固定延迟

早期方案通过隐藏/显示 native component、等待固定时间再 repaint。它会改变 native window 映射状态，却不能证明 Chromium 生成了完整帧，因而已删除。

### 3.2 重新应用 bounds

对 `cefBrowser.getUIComponent()` 重新应用当前 bounds 能进入 JCEF resize 链，对 windowed JCEF 有效，但 OSR 下只表示 resize 请求已发出。

### 3.3 R11/R12 的 120ms + 120ms OSR 补偿

旧实现按如下固定时序执行：

```text
等待 120ms
→ setBounds + wasResized
→ 再等待 120ms
→ markCompletelyDirty + paintImmediately
→ 消费 pending
```

实机已经证明该方案不充分：即使所有调用成功，`paintImmediately()` 仍可能画出旧 backing image。Timer 到期也不能作为新 OSR frame 到达的证据。

### 3.4 double-rAF / zoom nudge 被误当成完成确认

前端跨帧 zoom nudge 对 windowed ghosting、弹窗残影仍可作为经验性补偿，但隐藏页面的 rAF 可能暂停，timer fallback 也不表示产生了 compositor frame。因此 OSR pending 的成功不再依赖 `forceWebviewRepaint()` 回调。严格 OSR pulse 活跃期间，普通 repaint 会被模块级 coordinator 合并并延后，避免多个 zoom 写入跨帧交错。

## 4. 最终设计：真实 OnPaint full-frame fence

### 4.1 前端只确认 DOM commit

`historyLoadComplete` 仍具备启动前 placeholder，并保留显式零消息、快照顺序和 history epoch 保护。

历史消息 state 被 React 提交后，`useLayoutEffect` 发送：

```text
history_dom_committed:<historyRenderCommitEpoch>
```

该事件只表示历史 DOM 已 commit，不声称 Chromium 已栅格化，更不声称 OSR 像素已经显示。Java 暂时兼容旧的 `history_render_complete` 事件名，但新前端不再发送它。

### 4.2 保留 JetBrains 默认 OSR 实现

创建 browser 时，只要提供了自定义 `JBCefOSRHandlerFactory`，就无条件把它注入 builder，不能依赖插件在 build 前预判的 OSR 模式。IDEA 2025.2 Remote JCEF 会忽略 macOS 上请求的 `setOffScreenRendering(false)` 并在 builder 内部改为 OSR；若仅在预判 OSR 时注入，最终 Remote browser 会绕过 frame fence。真正的 windowed browser 不使用该字段，因此无条件注入不会改变其渲染路径。

factory 先调用 JetBrains 默认 factory 创建原始 component 和 render handler，再只包装返回给 CEF 的 handler：

- 不替换 `JBCefOsrComponent`；
- 不重新实现鼠标、键盘、IME、HiDPI 或共享内存；
- 所有未拦截方法，包括 `disposeNativeResources()`，原样委托给默认 handler；
- windowed JCEF 不经过 OSR handler，原路径保持不变。

带自定义 factory 的构建采用 fail-closed：builder 或后置配置失败时先 dispose 已创建 browser，然后拒绝创建一个没有 wrapper 的 Remote OSR fallback。只有未请求自定义 factory 的旧调用路径才允许退回默认构造器。

IDEA 2024.1 与项目 2024.3 编译基线暴露默认 factory 的 API 形状不同，代码通过反射兼容 `DEFAULT` 字段与 `getInstance()` 方法。

### 4.3 Remote 与经典 OSR

Remote JCEF 的 `CefNativeRenderHandler` 不是所有支持版本都有。实现只按类名动态加载：

- 接口存在且默认 handler 实现它时，代理同时实现 Remote 接口；
- 接口不存在时，代理只实现经典 `CefRenderHandler`；
- 代码没有对 `CefNativeRenderHandler` 的静态类型引用，旧 IDE 可以加载同一插件二进制。

最终 Remote frame 调用默认 handler 时，把非 popup 的 `dirtyRectsCount` 改为 `0`，要求 JetBrains 从共享内存复制整幅 raster。经典 OSR 则将 dirty rect 替换为 `(0, 0, width, height)` 的整幅矩形。

Popup paint 和没有 active request 的普通 frame 完全透传。

### 4.4 serial、pending 与 active attempt

每次 refresh request 都带完整身份：

```text
browser identity
CefBrowser identity
page generation
frontend-ready epoch
content revision（frontend shell=0，history commit epoch>0）
request serial
attempt id
reason
```

状态机为：

```text
PENDING
  ↓ 页面 showing、displayable 且尺寸有效
WAITING_PHASE_A_APPLIED
  ↓ 前端确认精确 token 的 phase-A mutation 已执行
DRAINING_FIRST_FRAME
  ↓ 第一个真实非 popup OnPaint（正常透传）
WAITING_PHASE_B
  ↓ Java 请求 phase B，但 final gate 继续关闭
WAITING_PHASE_B_APPLIED
  ↓ 前端确认精确 token 已恢复透明 sentinel
WAITING_FINAL_FRAME
  ↓ 第二个真实非 popup OnPaint（强制 full-frame）
PAINT_QUEUED
  ↓ EDT 重新校验身份与可见性并 paintImmediately()
COMPLETED
```

同一 browser、generation、ready epoch 下，`frontend_ready` 创建 revision 0；每个新的 `historyRenderCommitEpoch` 创建更高 revision。同一或更旧 revision 无论仍在 pending、正在 active，还是已经发布，都复用现有 watermark，不生成新 serial。只有 `complete(attempt)` 能推进 `lastPublishedSerial`，lifecycle invalidation 会同时清除 pending、active 和 published watermark。

`OnPaint` 本身不携带 serial 或 attempt id，因此实现不能让 B 直接覆盖正在等待帧的 A。request serial 表示一条逻辑 pending 请求；attempt id 表示该请求的某一次具体 arm。相同 serial 超时后重新 arm 也会得到不同 attempt id。当前模型同时保存：

- 一个 active attempt；
- 一个 latest pending request。

A 的迟到 frame 只能推进 A；B 在 pending 中等待。A 完成时只消费 A，随后再 arm B。旧 A 永远不能清除新 B；同一 request 的旧 attempt 也不能释放、完成或取消新 attempt 的 timeout。

### 4.5 第一帧 drain 与最终帧发布

页面真正可见后 arm 当前 request，但 paint gate 保持关闭。Java 随即调用前端 phase A。前端在 React `#app` 外创建固定定位、2 CSS px、`pointer-events:none`、`contain:strict` 的 sentinel，并写入低透明度但非零的真实背景色。sentinel 不改变字体、布局、滚动位置，也不读取 `#app.offsetHeight`。前端确认样式 mutation 后通过 generation-gated bridge 返回精确 `token + phase + applied` ACK；只有 ACK 被当前 attempt 接受后，fence 才进入 `DRAINING_FIRST_FRAME`。ACK 前到达的自然 frame 全部透传。

第一个匹配的 `OnPaint` 只作为 drain frame，仍按原 dirty rect 交给默认 handler。fence 先进入 `WAITING_PHASE_B`。Java 重新检查 browser、generation、ready epoch、serial、attempt、showing 和尺寸后进入 `WAITING_PHASE_B_APPLIED`，再调用前端 phase B 把 sentinel 恢复为 transparent。`executeJavaScript()` 只代表脚本已提交，因此不会开放 final gate；只有前端确认 Phase B mutation 已实际执行后才进入 `WAITING_FINAL_FRAME`。Phase B ACK 前的自然 frame 仍只能透传。

第二个匹配 frame 才强制 full-frame 并交给默认 handler。之后在 EDT：

1. 再次验证 request 身份和 native component；
2. `markCompletelyDirty()`；
3. `paintImmediately()`；
4. paint 返回后只完成当前 serial + attempt id；
5. 如果还有更新的 pending request，立即开始下一条 fence。

若 A 完成或超时时 B 已 pending，Java arm B 后调用前端 `replace(A, B)`。前端在同一个 JS task 内校验 A 的精确 token，并把 sentinel 直接切换为 B 的另一个 raster variant 后发送 B 的 applied ACK；相邻 attempt 交替使用两种颜色，避免写回相同样式被 Chromium 合并。整个过程不释放普通 repaint waiter。若 B 在 ACK 前超时，取消命令同时携带 B 与其 predecessor A，避免脚本丢失后遗留永久 sentinel。只有整个 fence 队列清空后，普通 dialog/session repaint 才合并执行。

### 4.6 隐藏、失效与超时

如果 native child 未 showing、未 displayable、尺寸无效或窗口 iconified：

- 结束 active attempt；
- 保留 latest pending；
- 等 `componentShown`、resize、Tab 激活或窗口恢复后重新 arm。

请求创建与执行资格严格分离：新的 `frontend_ready` 即使隐藏也必须创建 pending；active/showing/displayable/size 只决定当前能否 arm。Tab 激活、component showing 和窗口恢复都只能唤醒已有 publication pending，不能生成新的内容 serial。

若当前内容已经发布且没有 publication pending，OSR Tab 激活只创建一条独立的 cached-presentation 请求，对现有 JetBrains backing image 执行 `markCompletelyDirty()`、`repaint()` 和必要的 `paintImmediately()`。native child 尚未 showing 时该请求单独保留到后续 hierarchy 事件；它不会制造 Chromium damage，也不会推进或消费 publication fence。

以下事件同时淘汰 pending 和 active attempt：

- `frontendReady=false`；
- page generation 改变；
- browser recreate/replace；
- window dispose。

保留一个约 1 秒的一次性 timeout，仅用于释放没有收到 phase ACK 或 frame 的 active attempt。Phase B 请求和 Phase B ACK 后都会为同一 attempt 更新相应阶段的 timeout。timeout 所有权同时绑定 attempt 对象和具体 Runnable：迟到的 A callback 不能取消 B 的 timeout，也不能取消同一 request 新 attempt 的 timeout。

释放操作会原子区分 active A 与 latest pending：

- 若 pending 仍是同一个超时请求 A，不重新 arm，避免每秒循环；
- 若期间已有更高 serial 的 B，释放 A 后立即且仅一次把执行权交给 B，避免组件已经 showing、却再也没有生命周期事件来唤醒 B；
- timeout 本身不消费 pending，也不把 Swing repaint 当成 frame 完成。
- 每个 attempt 只执行一组 phase A/B pulse；超时后保留 pending，但同一请求不会被 timer 自行循环重试。

## 5. Windowed JCEF 与其他 repaint 场景

Windowed JCEF 继续重新应用真实 native component bounds，并执行 validate/repaint 和 screen info 通知。它不经过 OSR frame fence。

`forceWebviewRepaint()` 仍可用于：

- windowed JCEF Tab activation 的前端 ghosting 补偿；
- changelog/dialog 关闭残影；
- session transition 或输入区布局变化。

Remote/经典 OSR 的普通 Tab 激活不再调用 generic zoom，只呈现 cached backing image。其他 timer/rAF callback 在真正写入前仍检查 strict pulse 所有权；即使 generic repaint 先排队、OSR pulse 后开始，也会延迟到 pulse 结束。dialog 和 session transition 的 legacy zoom mutation 通过同一个模块级 coordinator，不能消费 OSR history pending。

## 6. 与既有修复的关系

- watchdog soft recovery 继续使用 native `reload()`，不会重新注册 `loadHTML` payload；
- hidden Tab 不执行 bridge retry/reload/recreate 风暴；
- generation、ready epoch 和 browser identity 继续隔离旧页面任务；
- history callback placeholder、显式零消息和 session transition guard 均保留；
- 本修复不改变 provider/model/context usage 逻辑。

## 7. 跨版本兼容核对

本机 API 核对结果：

- IDEA 2024.1.1：存在 `JBCefOSRHandlerFactory` 与 builder 注入方法；不存在 `CefNativeRenderHandler`；
- 项目 IDEA 2024.3 编译基线：默认 factory 提供 `getInstance()`；
- IDEA 2025.2.6.2：存在 Remote `CefNativeRenderHandler` 和 `onPaintWithSharedMem()`。

因此：

- 2024.1/经典 OSR 使用 `onPaint(Rectangle[], ByteBuffer, ...)` full rect；
- 2025.2 Remote OSR 使用 shared-memory callback 和 dirty count `0`；
- macOS/Windows 若最终 browser 确实是 windowed rendering，则完全保持 windowed 路径；若 Remote JCEF 覆盖请求并创建 OSR，预装的 factory 会自动接管 OnPaint。

## 8. 自动化测试约束

测试必须长期锁定：

- 第一帧只 drain，第二帧才允许完成；
- Phase A/B ACK 前的自然 frame 只能透传；
- 重复、乱序或错误 token 的 phase ACK 不能推进状态；
- phase A/B 从不修改 `#app.style.zoom`，只改变 `#app` 外的 sentinel；
- phase A 使用非零透明 raster，phase B 恢复 transparent，finish/cancel 后无残留节点；
- replacement 的新 sentinel variant 必须与旧 Phase A 不同；
- Remote 最终非 popup frame 的 dirty count 为 `0`；
- 经典最终 frame 使用整幅矩形；
- popup 与非 pending frame 完全透传；
- `disposeNativeResources()` 等方法仍委托默认 handler；
- final callback 到达前不能完成 request；
- release/timeout 保留 pending，同一 A 不循环、更新的 B 会自动接棒；
- 迟到 A callback 不能取消 B 或重 arm attempt 的 timeout；
- 普通 repaint 在严格 pulse 期间合并延后；
- 普通 repaint 先排队、pulse 后开始时，执行阶段仍必须重新检查所有权；
- timeout handoff 通过精确 `replace(A, B)` 原子转移前端所有权；
- 请求 windowed 但 Remote 最终强制 OSR 时仍会安装 handler factory；
- B 不会被 active A 的完成清除；
- generation、ready=false、browser replace 和 dispose 使旧 callback 失效；
- hidden frontend-ready 创建 pending 但不 arm，首次显示消费同一 serial；
- 已发布 OSR 的普通 Tab 激活不创建 serial，只执行 cached presentation；
- timeout 后由激活重试时 serial 不变、attempt id 增加；
- React 只在 DOM commit 后发送带 epoch 的 `history_dom_committed`，重复 epoch 不生成 serial；
- 早到的 `historyLoadComplete` 和显式零消息仍能正确 drain。

## 9. 维护约束

1. 不要再用固定延时推断 OSR frame 已到达；
2. 不要把 rAF、Timer、`wasResized()` 或 `paintImmediately()` 单独当作像素完成证明；
3. 不要替换 JetBrains OSR component 或自行管理共享内存；
4. 不要静态引用只存在于新 IDE 的 Remote handler 类型；
5. 不要让新 pending request 覆盖 active attempt 的 frame 归属；
6. 不要让 request serial 代替 attempt identity；同一请求可以被重新 arm；
7. 不要在严格 phase A/B sentinel pulse 之间执行普通 zoom repaint；
8. 不要把 `executeJavaScript()` 返回当成 phase mutation 已执行；必须等待精确 ACK；
9. 不要在历史 surface 恢复中 reload 页面或重新调用 `loadHTML()`；
10. 修改 Java 单元测试时必须维护类级和方法级目标注释。

## 10. 最终验证记录与范围边界

最终实机包为 `0.5-beta1-FIX-d86618bb-r18`。验证覆盖 IDEA 2025.2 下多个同时恢复的项目窗口和多个 CC GUI Tab：

- 连续多轮冷启动和重启均能发布首个可见 Tab 的完整历史内容；
- 普通 OSR Tab 切换不创建新的 publication serial，只重画已发布的 cached backing image；
- Tab 切换期间未再观察到 app-wide zoom 造成的字体或布局抖动；
- active attempt 仍被视为 unpublished，只有最终 full-frame `OnPaint` 转交默认 handler 并完成 Swing paint 后才推进 published watermark；
- 个别 attempt 超时时只释放 attempt 并保留原 pending，不会消费内容版本或形成 timer 自循环；后续可见性事件使用相同 serial 和新的 attempt id 重试。

休眠唤醒验证进一步覆盖了恢复边界：IDE 唤醒后 watchdog 只执行一次有界 native reload，会话恢复并下发 222 条历史消息；publication `serial=8` 的首次 `attempt=3` 在窗口尚未完全激活时超时并保留 pending，窗口激活后以相同 serial 的 `attempt=4` 成功发布最终 full frame。期间没有出现 WebView reload/recreate 风暴，也没有重新注册 `loadHTML` payload。

本次唤醒同时观察到多个 Claude daemon 把系统休眠造成的 heartbeat 空洞误判为进程死亡，并集中重启。该现象不属于 JCEF surface publication 链路，已由 #1601 独立跟踪；不得为了处理 daemon 生命周期而扩大本修复的职责范围。

最终代码验证包括完整 Gradle 测试、Checkstyle、前端测试、TypeScript/Vite 生产构建和 `git diff --check`。自动化测试与实机日志共同覆盖了 DOM commit、phase ACK、双帧 fence、full-frame forwarding、cached presentation、隐藏页面 pending、timeout retry 和生命周期失效等关键不变量。

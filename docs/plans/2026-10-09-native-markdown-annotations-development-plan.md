# IDE 原生 Markdown 预览批注：完整开发与验证计划

日期：2026-10-09。状态：首版功能已实现，Windows / IntelliJ IDEA Community 2024.3.1 的真实原生预览联调和重启恢复已通过。下文保留完整开发路线；未列入实测结果的验收项仍待验证，不代表全部完成。

## 0. 本次实现与验证记录

### 已实现的首版

- 通过 Markdown 插件的可选扩展点，在 IDE 自带预览中加载独立 JS/CSS；文件渲染仍由原生插件负责。
- 选中文本后显示悬浮批注/引用操作栏；支持新增、查看、编辑、删除、定位源文、数量与标记。弹窗文字使用 textContent，编辑框在重绘期间保留输入。
- 以项目服务保存批注，UTF-16 范围与 Document 一致。原文可唯一匹配时定位到源码片段；含 Markdown 格式的选文由 IDE 原生生成器验证，保留块范围和原始 Markdown 上下文，不伪装为精确字符定位。
- 使用 RangeMarker 跟踪未保存编辑；删除或歧义保留原文与批注并标记状态。原生 IncrementalDOM 更新后恢复覆盖层。
- 当前文件全部批注或弹窗中的单条批注可加入 CC GUI；引用可直接加入聊天。多标签时提供目标选择，固定目标与会话代际，重试批次去重。
- 聊天输入框显示可展开、逐条移除的批注草稿。发送前冻结原文、源码上下文、修订、位置、SHA-256 和批注正文，与整体要求组成一条消息，复用现有发送/排队路径。仅批注也可发送。
- 批注和交接快照默认只在当前项目打开期间保存在 Java 项目服务的内存中；项目关闭或 IDE 重启后不恢复。设置中的“重启后保留批注和待发快照”开启时，才存入 `.idea/workspace.xml` 的 `CCGuiMarkdownReview`；schema v3 使用 Base64 JSON 封装并转义 UTF-16 代理字符，避免原生 XML 存储损失 emoji。设置本身始终按项目保存。聊天目标身份存入 `.idea/claudeCodeTabState.xml`；新会话生成新的身份，避免空会话混用草稿。
- 选择/批注正文上限各 32,000 字符，源码范围 64,000，批次 200,000，批注与输入合计 256,000；超限提示，不截断。格式化选文的原生验证限制文档不超过 500,000 字符。

### 实测证据及范围

| 检查 | 本次结果 |
| --- | --- |
| 环境 | Windows 11；IC-243.22562.145 / IDEA Community 2024.3.1；IDE JBR 21.0.5；Gradle 构建 JDK 17.0.19 |
| 原生 DOM | `meta[name=markdown-position-attribute-name]` 为 `md-src-pos`；原生 DIV 根范围 `0..270` 与测试 Document 长度一致，结束偏移不包含在范围内 |
| 真实 runIde / JCEF | 首版 14 项通过：CSP、消息桥 CRUD、文字编码、主题和坐标、聊天 ACK、格式化选文、引用、未保存编辑、重绘、快照、删除失效、重开及保存。最新生命周期配置另有 9 项通过：受影响清理、未修改原文保留、快照、开关和存储策略 |
| 重启与会话隔离 | 最新非持久化策略重启 3 项通过：设置保留、批注/快照为空、原生入口可重新启用。此前首版的持久化恢复、空会话隔离及 Unicode 恢复亦通过；这些恢复场景现在需要显式开启持久化 |
| 前端 | 最新全量 206 个测试文件 / 1,926 项测试通过；主/测试类型检查与生产构建通过；新增快捷键和设置页交接浏览器回归通过 |
| 浏览器端到端 | 批注/引用、聊天提交、功能开关、自动草稿和本地化提示在桌面/窄窗口通过；浏览器 fixture 与真实原生 IDE 结果分别记录，详见 2026-10-13 修订 |
| Java / 构建 | 最新批注服务 11 项测试、checkstyleMain 与 buildPlugin 通过；覆盖非持久化、设置保存、自动草稿替换、编辑边界、整份文件修改和 Unicode XML 往返。全量上一轮 1,453 项中 1,441 通过、11 跳过、1 失败，不能标记全量回归通过 |
| 未通过的回归 | `CodexHistoryPageIndexTest.replacementWithPreservedSizeAndMtimeRebuildsIndex` 在 Windows 重复失败：同大小、同修改时间的文件替换后，索引返回 old 而非 new。历史索引实现与该测试未在本分支修改；已保留失败日志，未跳过或改写断言 |
| 安装包内容 | 最新 `idea-claude-code-gui-0.5.9-markdown-review-selection-fix.zip` 包含原生 JS/CSS、可选扩展描述、Java 配置/桥接类、设置界面及 agent 处理协议；不包含 NativeMarkdownSmokeActivity 测试驱动 |
| AI 后端 | 已验证最终 `send_message` 文本的前端桥接 payload，包含原文、Markdown 上下文、批注、路径与 hash；没有调用真实 Claude/Codex 模型，本次没有 provider 成功回执证据 |

可复现命令（仓库根目录，JAVA_HOME 为 JDK 17）：

```powershell
cd webview
npm ci
npm test
npm run build
npx playwright test e2e/native-markdown.spec.ts e2e/chat-input.spec.ts -g "annotates|quotes directly|review-only" --project=chromium-desktop --project=chromium-narrow
cd ..
.\gradlew.bat test checkstyleMain buildPlugin -PskipWebview=true
.\gradlew.bat -I scripts/native-markdown-smoke.init.gradle runIde -PskipWebview=true
# 在另一终端，等待测试 IDE 的原生预览与聊天加载：
node scripts/native-markdown-runtime-smoke.mjs
# 保存并重启同一测试 IDE 后，先验证恢复：
node scripts/native-markdown-runtime-smoke.mjs --restore-only
# 验证新建空会话并保存，再重启测试 IDE：
node scripts/native-markdown-runtime-smoke.mjs --reset-session
# 再次关闭并启动上述同一个测试 IDE，然后执行：
node scripts/native-markdown-runtime-smoke.mjs --new-session-restart
# 验证项目设置、自动清理、冻结快照和持久化开关：
node scripts/native-markdown-runtime-smoke.mjs --review-policy
# 保存关闭并重启同一测试 IDE 后，验证默认不恢复内容而保留设置：
node scripts/native-markdown-runtime-smoke.mjs --review-policy-restart
```

测试 IDE 使用 `build/native-markdown-smoke` 和独立沙箱；本地 JCEF 调试端口 9228 仅由此测试启动启用。开发测试驱动属于测试源码，生产插件不包含它。运行报告与截图位于 `build/native-markdown-smoke/{runtime-report.json,restart-report.json,native-preview.png,chat-review-draft.png}`。

全量回归日志为 `build/java-final-checks.log`；前端日志为 `build/frontend-final-tests.log`；最终 11 项针对性回归及成功构建日志为 `build/markdown-final-tests.log`。全量联合命令因历史索引测试失败返回失败；最终针对性回归、代码检查、安装包构建联合命令返回成功，未把全量失败描述为成功。

### 使用与当前限制

通过 IDE 的“从磁盘安装插件”安装最新包 `build/distributions/idea-claude-code-gui-0.5.9-markdown-review-selection-fix.zip`，重启 IDE，确认原生 Markdown 插件已启用，并在 CC GUI 的基本设置 → 行为中开启 Markdown 批注（默认关闭）。打开 `.md` 文件的 IDE 预览，选文 → 批注 → 输入 → Enter 添加；可在同页切换批注录入快捷键。点击发送图标，在聊天输入中查看批注和原文，可补充整体要求再发送。引用入口直接建立引用草稿，不新增文档批注。

当前实测支持范围只有 Windows + IDEA 2024.3.1 的 JCEF 原生预览。代码对 build <243 或缺少项目/文件/消息桥的面板不创建批注扩展；未进行完整 Plugin Verifier、IDE 261/262、PyCharm/Rider/WebStorm、禁用 Markdown、远程开发及其他系统运行测试。可选依赖声明不等同于这些环境已经通过验收。

`received` 表示聊天草稿收到，`queued` 表示已交给现有提交/排队入口，不表示模型收到。服务保留有界交接快照（最多 200 批），不自动重发；现有发送队列没有新增磁盘恢复能力。暂未提供失败批次恢复列表/导出、草稿“源批注已更新”提示与刷新按钮、批注快捷键、复杂图形批注、多面板及文件夹重命名的实测保证、完整 IME/性能/内存矩阵。以下路线中的这些要求仍属于后续工作。

### CC GUI 样式统一（2026-10-09）

- 原生批注层局部导入 CC GUI 的 `variables.less`，复用深浅主题配色、边框和阴影；变量限定在覆盖层内，不覆盖 IDE 原生 Markdown 文档样式。主题随原生预览的深浅配色选择，聊天的独立主题偏好暂未同步至原生预览。
- 统一蓝色主按钮、次级/删除按钮、8px 弹窗圆角、输入框焦点边框和线性批注图标；数量与发送入口移到右下角，弹窗和操作栏保留视口边界限制。
- 聊天批注草稿使用输入框及附件的现有变量，统一折叠、文件、关闭图标及引用卡片，适配窄窗口和长文件路径。
- 本次样式更新后，桌面/窄窗口交互回归 6 项通过；额外核对深/浅主题 × 桌面/窄窗口 4 种组合，确认与聊天的背景及强调色变量一致、变量未泄漏到原生正文、原生 DOM 未变化、弹窗完整处于视口。浏览器截图及报告位于 `build/style-preview`，此样式核对未重新运行真实 IDE 测试。
- 前端生产构建、checkstyleMain 和 buildPlugin 成功。日志为 `build/style-build.log`、`build/style-e2e.log`、`build/style-plugin-build.log`。旧 ZIP 被其他进程占用，因此保留旧包，并生成独立的 `idea-claude-code-gui-0.5.9-markdown-style.zip`；源码构建的默认包名仍保持原有设置。

### 批注生命周期与 agent 处理说明（2026-10-09）

CC GUI 的“设置 → 基本设置 → 行为”新增三个项目级开关：

| 设置 | 默认 | 行为 |
| --- | --- | --- |
| 启用 Markdown 预览批注 | 关闭 | 开启后显示交互层；关闭立即隐藏当前及后续原生预览的交互层，拒绝批注操作；保留当前内存数据，重新开启无需重开预览 |
| 自动删除受修改影响的批注 | 开启 | 原文范围内部插入、替换或删除时清理受影响批注；边界外插入仅移动位置；关闭时保留并标记原文变化 |
| 重启后保留批注和待发快照 | 关闭 | 默认不写入批注内容；开启后 IDE 保存至工作区；再次关闭后下次 IDE 保存移除持久化内容，当前内存草稿继续可用 |

自动清理针对实际源码编辑范围，不判断修改是否完成业务要求。它同样适用于人工修改；块级批注以该源码块为范围。整份文件重写时先去掉公共前后缀；被整段替换覆盖、但源码快照在替换前后都唯一且完整保留的批注继续保留。重复或部分修改仍按受影响范围处理，不跳转到另一处同文。自动清理不会删除已交接的冻结快照，也不清理正常聊天历史。关闭批注功能时暂停自动清理。自动删除不随源码撤销恢复，未完成要求应从聊天快照中继续处理。

`webview/src/nativeMarkdownAnnotations/agent-guide.md` 是随每条批注消息自动附带的处理协议，不需要用户在各 provider 中安装 skill。要求 agent 对照当前文件逐条修正和核验，在结束前报告已完成 ID，并明确提示每个未完成/部分完成项的 ID、文件、原始要求、原因及下一步。即使实时批注被清理也必须报告未完成项；不得把批注消失当作完成证据，也不得编辑 IDE 状态文件清理批注。关闭自动清理时，由用户在原生预览手动删除。普通引用消息不注入这套批注处理协议。

提示词属于给 agent 的处理要求，不是模型完成检测器；插件不会凭模型的完成声明自动确认要求已实现。历史 v2 工作区数据默认按非持久化策略不恢复。设置切换以 Java 的实际回执为准。

本轮验证：前端全量 202 文件 / 1,907 测试及类型检查、10 项浏览器交互、15 项 Java 针对性回归、代码检查与安装包构建全部通过。Windows / IDEA 2024.3.1 的原生生命周期 9 项及重启 3 项通过。日志为 `build/review-policy-{full-frontend-tests,e2e,runtime,restart,final-package}.log`，真实 IDE 报告为 `build/native-markdown-smoke/{policy-report,policy-restart-report}.json`。测试启动脚本已修正旧退出指令重放及测试插件缓存问题；最终沙箱正常关闭。未实测真实 Claude/Codex 模型是否遵守未完成项提示规则。

## 1. 已确定的方向与仓库状态

### 2026-10-12 修订

- 已 fetch 核实并将 `feature/markdown-artifact-annotations` rebase 到 `origin/fix/cc-switch-claude-aggregation` 的 `9c42553f`。此前未提交的全部功能改动先保存为 stash `0ff91c741d853610f45ca4eab2529ddbb3348394`，再恢复到功能分支；备份保留。Claude 修复分支和远程未被修改。
- 移除前端每条消息拼接的长规则。`MarkdownReviewPrompt.GUIDE` 为不足 600 字符的固定处理协议，走现有 agent/system context。Claude 第一次收到批注后启用该上下文，持久查询的系统配置保持稳定，后续普通消息和压缩不丢失，换会话重置；恢复历史可重新启用。其他 provider 复用现有隐藏 agent context，仅批注消息追加精简规则，不承诺这些 provider 原生支持系统消息。
- 冻结批注使用 `ccgui-markdown-review` version 1 数据封装，只保存路径、hash、位置、原文、批注及修订；去掉重复源码，转义字符串中的标签、引用标记和有意义的零宽字符，避免消息规范化或上下文展开改变快照。正常用户要求放在封装外。
- 聊天使用现有 compact-summary 系列样式的折叠上下文卡片，原文/批注/身份信息按需展开；蓝色正文仅显示用户要求。旧版本历史中的长规则前言在展示时隐藏，历史文件本身不重写。没有伪造 SDK 工具调用。会话摘要和历史预览使用用户要求或文件名，不显示协议 JSON。
- 批注功能默认关闭；已保存的偏好仍按项目恢复。原生覆盖层通过 Java 获取 CC GUI 的语言设置，并在设置变化时刷新，支持与应用相同的 10 个语言代码及英文回退。弹窗改为编辑、删除、定位、发送、关闭的单行图标栏，带本地化 tooltip/aria-label；发送按钮在宽预览显示短文字，200px 预览只保留图标。底部计数/发送入口也保持一行。
- 验证：完整前端回归 205 文件 / 1,922 项通过，后续冻结字符与消息渲染针对性回归通过；类型检查与生产构建通过。Java 批注、会话发送、历史预览及 API 规则共 57 项和代码检查通过。桌面/窄窗口浏览器交互 12 项、深浅主题外观 4 组合、真实 IDEA 2024.3.1 原生生命周期 9 项通过。截图位于 `build/review-refinement-preview`，日志为 `build/review-refinement-*.log`。没有调用真实 Claude/Codex 模型验证其回复是否遵守协议；旧的无关全量 Java 历史索引失败记录仍保留。

### 2026-10-13：自动加入聊天草稿与位置显示

- 项目设置新增“自动将批注加入当前聊天草稿”，默认关闭。开启后，新建和保存编辑的单条批注经 IDE 项目服务冻结为快照，直接交给当前选中的 CC GUI 聊天输入框并展开草稿列表，不调用模型发送，也不弹出多聊天选择框。用户可收起列表，下一条自动批注到达时再次展开。编辑同一批注时，只替换同一目标中尚未发送的自动草稿；手动交接与已排队的快照保留。聊天不可用时原批注仍保存，并以本地化提示告知手动加入，避免用户重试时重复创建。
- 原生预览的“加入成功 / 批注已保存但交接失败 / 加入失败”状态由响应代码在前端按语言翻译；与原生操作按钮同样覆盖 en、zh、zh-TW、ja、ko、fr、es、ru、pt-BR、hi。CC GUI 设置项为中英文界面各提供标题和说明。
- 草稿和已发送的上下文卡片将位置标签放在右侧，使用文件名开头最多 10 个 Unicode 字符加 `起始行:结束行`（例 `柜机数据WSS接口文… 30:30`）。悬停标签可查看完整路径；草稿的逐条移除按钮同排放在右侧。界面不再显示“原文块 · 已定位”字样，源文和状态仍保存在冻结数据中。
- 验证：前端全量 206 文件 / 1,925 项通过，TypeScript 主/测试类型检查、生产构建通过；新增设置/替换/位置单元测试。浏览器桌面/窄窗口相关交互 22 项通过，另验证中文失败提示与保留批注、草稿右侧标签，以及自动批注到达后展开、用户可收起（2 项）。真实 IDEA 2024.3.1 沙箱新增 6 项检查：默认关闭不投递、开启后进入当前聊天草稿、编辑替换未发送草稿、关闭开关、右侧文件行号、移除旧状态文字。最终 Java `MarkdownReviewServiceTest` 11 项、`checkstyleMain`、`buildPlugin` 通过；安装包为 `build/distributions/idea-claude-code-gui-0.5.9-markdown-review-auto-draft.zip`，核对了原生资源和 Java 类存在且不含测试驱动。真实模型发送及其他 IDE/平台兼容仍待验证。

### 2026-10-13：批注键盘录入与设置页交接修复

- 项目设置新增独立的“Markdown 批注录入快捷键”：默认 Enter 添加/保存、Ctrl+Enter 换行；可切换为 Ctrl+Enter 添加/保存、Enter 换行。Shift+Enter 始终换行，macOS 支持 Command；中文输入法确认和按键重复不提交。配置在已有项目偏好中保存并实时同步到原生预览；Ctrl+Enter 换行显式更新 textarea 选区和值。
- 自动草稿的确定性失效场景是 CC GUI 停留在设置页：App 替换聊天子树，输入组件及 addArtifactReview 回调被卸载。新增常驻的 showArtifactReviewChat 导航回调，交接先切回聊天；新输入挂载发出 artifact_review_ready 后，Java 按既有目标/会话代际重放 pending/received 草稿。恢复自身不触发导航，避免页面初始化或普通设置页访问被打断；重放按批次 ID 去重，不自动发送模型请求。
- 已验证：前端全量 206 文件 / 1,926 项与测试类型检查通过；生产构建通过。桌面/窄窗口 10 项相关浏览器回归涵盖 Enter 添加/保存、两种换行模式、IME/长按保护、设置页卸载后恢复及聊天原有快捷键。真实 IDEA 2024.3.1 沙箱新增 6 项检查通过，使用 CDP 键盘事件在设置页状态下 Enter 添加、Ctrl+Enter 保存，真实 BrowserPipe/聊天 ACK 确认一份更新后的草稿；报告为 build/native-markdown-smoke/settings-handoff-report.json。Java 配置默认值与保存恢复、checkstyleMain、最终 ZIP 构建见 build/comment-input-fix-build.log；当前交付包为 idea-claude-code-gui-0.5.9-markdown-review-input-fix.zip。未调用真实模型，也未扩大其他 IDE/平台的实测支持范围。

**核心路径：复用 JetBrains IDE 自带的 Markdown 文件渲染与预览，在其预览页面上增加批注交互，再把批注和原文上下文交给 CC GUI 的聊天输入及发送链路。**

### 2026-10-13：录屏中的跨列表批注提交失败

- 已读取用户录屏：选中“缓存的idex/url…”、“增加允许导入导出…”、“数据库引入应用版本管理…”三个列表项后，提交被源码匹配拒绝，数量仍为 0。原因是 DOM Range.toString() 直接拼接各项文本，而原校验以 wholeText 加人工空格拼接源块；跨列表及 br/checkbox 等渲染结构与浏览器返回的字符串不一致。
- 将原生生成 HTML 的选区校验拆为 RenderedSelectionMatcher：按 DOM 文本节点顺序拼接，不生成列表编号、复选框文字或 br 分隔；兼容块间有空白的选文，仍限制到指定源码范围、排除重复嵌套范围。所选文字原样保存，跨列表保留整个源块和原始 Markdown 上下文，不当作精确字符锚点。匹配失败返回 selectionMismatch 本地化代码，覆盖原生层全部 10 种语言。
- 验证：Java 新增 3 项回归覆盖无空格的三项中文列表、部分跨项选择、有换行的跨项选文、格式化/checkbox/br 文本、越界和伪造文字拒绝、嵌套节点去重；前端选区/语言 4 项通过，生产构建通过。真实 IDEA 2024.3.1 新增 4 项验证：录屏中的三项选区成功保存精确引文及完整源码、自动加入并展开聊天草稿、跨项直接引用、跨复选列表提交。报告及截图为 build/native-markdown-smoke/multi-block-report.json 和 multi-block-chat.png；最终测试/代码检查/安装包日志为 build/selection-fix-build.log。最新交付包为 idea-claude-code-gui-0.5.9-markdown-review-selection-fix.zip；未发送真实模型请求。

项目已有的 MarkdownBlock 是聊天消息渲染组件。本功能的文件展示、解析、相对图片、链接、公式、图表和源码/预览布局由 IDE Markdown 插件负责。批注扩展只添加交互层，不新建 Markdown 文件渲染器或独立预览编辑器，也不把聊天 WebView 搬进文件预览。

| 项目 | 当前状态 |
| --- | --- |
| Git 根目录 | D:\code\cc-gui\jetbrains-cc-gui |
| origin fetch / push | https://github.com/IcarusAegis/jetbrains-cc-gui.git，已修改并核对 |
| 当前功能分支 | feature/markdown-artifact-annotations |
| 起点提交 | 7bcd6c3803ec44944cef90f5bff0aa666cab99a2 |
| fork 只读检查 | git ls-remote 确认 fork 的 HEAD / main 为同一提交；普通沙箱网络失败后，网络权限检查成功 |
| 本地远程跟踪引用 | 已 fetch fork，核对 origin/main 与起点提交 |
| 后续集成 | 本次保留在本地功能分支；若向原项目提 PR，再按 CONTRIBUTING.md 核实当时的版本开发分支 |

本次已实现首版功能并完成上述验证；尚未提交或推送。本文件包含研究结论、完整路线和实际验证记录。

## 2. 现有能力与复用边界

| 现有位置 | 已确认行为 | 本功能中的用途 |
| --- | --- | --- |
| build.gradle / META-INF/plugin.xml | Java 17；默认 SDK IDEA Community 2024.3.1；支持 PyCharm / Rider 构建；声明 build 233–263.*；未声明 Markdown 依赖 | 添加可选 Markdown 依赖和适配模块，逐版本验证 |
| webview/src/components/MarkdownBlock.tsx | 聊天内容解析、高亮、图表等 | 保持聊天展示用途；不用于 .md 文件渲染或源码定位 |
| webview/src/utils/selectionOffsets.ts | 保存渲染文本的 DOM 选区偏移 | 借鉴选区保存方法；不能将其输出当作 Markdown 源码偏移 |
| action/editor/SendSelectionToTerminalAction.java / SelectionReferenceBuilder.java | IDE 源编辑器选文转文件行引用 | 借鉴 Action 注册及文件导航；不能直接获得浏览器预览选区 |
| ui/toolwindow/CodeSnippetManager.java | 向当前聊天标签投递；重试时重新查当前标签 | 借鉴打开聊天窗口；新批次投递需固定目标身份 |
| PendingCodeSnippetBuffer.java | 单槽缓冲，后到片段覆盖先到片段 | 不用于保存多条批注或多批投递 |
| WebviewEventQueue.java / MessageDispatchGate.java | Java→聊天事件队列及页面代际保护 | 批次进入聊天时利用现有生命周期机制，并增加确认与去重 |
| quoteRegistry.ts / useGlobalCallbacks.ts | 引用 chip 的页面内 Map；发送时展开 | 借鉴 chip 展示，批注用独立且可恢复的数据模型 |
| useMessageQueue.ts | 队列保存 content / attachments，稍后调用执行函数 | 批注必须在进入队列前展开并冻结，不能依赖届时仍存在的引用注册表 |
| useMessageSender.ts / SessionHandler.java / SessionSendService.java | 发送 text、附件及文件标签，沿当前会话路由到 provider | 原文和批注编码到 text，保留现有 provider、权限、排队和中断行为 |
| Vite 构建 / scripts/copy-dist.mjs | 当前生成并复制单个聊天 HTML | 增加独立的批注脚本/CSS构建产物，供原生预览资源扩展加载 |

## 3. 原生集成依据与必须验证的接口

以下最初来自 JetBrains 上游 master 源码及官方 SDK；本次已用实际 243 SDK 签名和真实 IDE 验证首版入口，全版本兼容仍需逐项验证。

| 能力 | 已找到的接口 | 实施前的验证 |
| --- | --- | --- |
| 加载扩展 | org.intellij.markdown.browserPreviewExtensionProvider；Provider.createBrowserExtension(panel) | 各 build 是否存在；接口签名、加载时机及替代接口 |
| 脚本/样式 | MarkdownBrowserPreviewExtension.scripts / styles / resourceProvider | 资源是否进入原生 CSP；预览重载、增量更新和重新打开后是否正常加载 |
| 原生消息桥 | MarkdownHtmlPanel.getBrowserPipe()；BrowserPipe.send / subscribe / removeSubscription | 非空能力、回调线程、生命周期、消息时序、可用平台版本 |
| 浏览器端消息 | window.__IntelliJTools.messagePipe.post / subscribe | 原生脚本初始化顺序、收到消息前后如何握手和恢复 |
| 文件与项目绑定 | MarkdownHtmlPanel.getProject() / getVirtualFile() | 两个方法在 master 标为 Experimental，默认可能返回 null；核实目标版本和面板类型 |
| 资源供应 | ResourceProvider.canProvide / loadResource | 插件类加载器读取固定 JS/CSS，显式 MIME/UTF-8，禁止任意磁盘路径 |
| 源码同步信息 | 243 已核实 `md-src-pos="start..end"`，以 Document UTF-16、结束偏移不包含在内；原生 IncrementalDOM 增量更新 | 其他 build 的属性与契约、复杂选区仍需逐项确认 |

**接口风险：** MarkdownBrowserPreviewExtension 在本次检查的 master 中标记为 Obsolete；MarkdownHtmlPanel 的消息管道及项目/文件方法标记为 Experimental。P0 必须针对实际发行 build 找到可用入口、验证替代接口并保存源码证据；不能仅凭接口名承诺全版本支持。

**约束下的处理方式：** 使用正常扩展点和可维护的版本适配；某 build 不支持时，只关闭该 build 的批注入口并保留原生预览与聊天。若首发目标也无法建立可靠消息桥或文件绑定，则记录具体阻塞并重新评估原生接口实现；不自动转向自建渲染，也不通过反射拿取私有浏览器。

来源：
[Markdown 扩展源码](https://github.com/JetBrains/intellij-community/blob/master/plugins/markdown/core/src/org/intellij/plugins/markdown/extensions/MarkdownBrowserPreviewExtension.kt)、
[MarkdownHtmlPanel](https://github.com/JetBrains/intellij-community/blob/master/plugins/markdown/core/src/org/intellij/plugins/markdown/ui/preview/MarkdownHtmlPanel.java)、
[BrowserPipe](https://github.com/JetBrains/intellij-community/blob/master/plugins/markdown/core/src/org/intellij/plugins/markdown/ui/preview/BrowserPipe.kt)、
[ResourceProvider](https://github.com/JetBrains/intellij-community/blob/master/plugins/markdown/core/src/org/intellij/plugins/markdown/ui/preview/ResourceProvider.kt)。

## 4. 第一版产品行为

以用户四张截图为交互参考；示例文档内容仅作为视觉材料。

1. 打开项目 .md / .markdown 文件，沿用 IDE 的源编辑、并排预览和仅预览模式。
2. 在原生预览选中文本，显示“批注 / 引用”悬浮操作栏。
3. 批注：保存选区后显示输入弹窗，支持添加、取消和中文输入法；保存后显示高亮、标记及数量。
4. 已保存批注：点击标记查看，支持编辑、删除及跳转源文；同一区域多条批注可以分别选择。
5. 引用：把原文及文件定位作为引用加入 CC GUI，不生成批注。
6. “加入 CC GUI”：当前文件中选定的批注组成一批，送入所选聊天；默认选择最近活动且仍有效的标签，并可更改目标。
7. 聊天输入框显示“N 条批注”，可展开查看原文、位置和批注，可移除某条或整个批次，并添加整体要求。
8. 点击聊天发送按钮，整体要求、原文及批注作为同一条消息沿现有流程发送；没有额外整体要求也允许发送非空批注。

首版支持文字选区，涵盖段落、标题、列表、链接和代码文本。表格、跨块选区必须实测后列入能力表；暂不支持的选区明确提示。图片、公式或 Mermaid 的图形内部节点暂不做图形批注，渲染表现保持 IDE 原有行为。

添加批注不写入 Markdown 正文。批注与待发批次本地保存；关闭重开文件或 IDE 可以恢复。麦克风、多人协作、云端同步、跨多文件打包及聊天回复上的批注不在首版范围。

## 5. 模块与构建设计

文件名为计划名称，P0 后确定具体适配接口。以现有 Java 技术栈为主，不为调用 Kotlin 定义的接口引入额外语言构建系统。

| 新增模块/文件建议 | 职责 |
| --- | --- |
| META-INF/ccgui-markdown-features.xml | 可选 Markdown 扩展注册；只有依赖可用时才加载相关类 |
| markdown/preview/NativeMarkdownExtensionProvider.java | 创建每个原生预览的扩展实例、资源注册 |
| markdown/preview/NativePreviewAdapter.java | 封装版本差异，暴露管道、项目、文件、源定位能力 |
| markdown/preview/PreviewBinding.java | panelId、generation、project/file/Document 绑定及销毁 |
| markdown/bridge/MarkdownAnnotationBridge.java | 原生管道订阅、窄消息协议、校验和响应 |
| markdown/annotation/MarkdownAnnotationService.java | 项目级批注状态、修订、持久化和多面板广播 |
| markdown/annotation/AnnotationAnchorResolver.java | 选区到源文映射、活动 RangeMarker、变化后重定位 |
| markdown/review/ReviewBatchService.java | 冻结批次、固定聊天目标、重试、去重和状态恢复 |
| markdown/review/ReviewContextSerializer.java | 原文与批注编码为可读消息，长度检查 |
| webview/src/nativeMarkdownAnnotations/ | 原生预览使用的 TS、CSS、悬浮栏、弹窗和覆盖层 |
| webview/src/components/ChatInputBox 的批注扩展 | 批次数量 chip、展开/移除、发送前取快照 |
| 原生预览独立构建脚本及资源目录 | 输出固定 JS/CSS，写入 src/main/resources/markdown-annotations |

依赖配置：
- 在 Gradle 为目标 IDE 添加 org.intellij.plugins.markdown 编译/沙箱依赖；是否 bundled 以具体产品的插件清单为准。
- 主 plugin.xml 添加 optional depends，config-file 指向上面的专用描述符。
- 核心聊天类、批注模型和投递服务不能在字段/方法签名中引用 Markdown 插件类型，确保依赖禁用时不触发类加载。
- 批注脚本采用独立入口，使用 DOM API 和现有工具链打包，不依赖聊天 App、marked、Mermaid 或聊天专用 window.sendToJava。
- 构建产物通过 ResourceProvider 提供，与聊天 HTML 的 copy-dist 分开；Gradle 的资源/打包任务必须包含该构建，不被现有 skipWebview 意外跳过。

可选依赖声明及 Markdown 插件 ID 依据：[JetBrains 插件依赖文档](https://plugins.jetbrains.com/docs/intellij/plugin-dependencies.html)。

## 6. 核心实现契约

### 6.1 面板绑定与原生消息协议

每个预览实例拥有独立 panelId / generation。创建时由 Java 绑定 Project、VirtualFile 和 IDE Document；同一文件的多个预览共享项目批注服务，分别保持自己的 DOM、滚动和焦点状态。

浏览器握手 ready → Java 返回 init（能力、文件身份、版本、批注）→ 浏览器显示交互。增量重绘不代表重建面板：用原生渲染完成事件（优先）或受限 MutationObserver（备选）重新定位覆盖层，禁止重复绑定监听。

每条请求包含 protocolVersion、requestId、panelId、generation、renderRevision、documentVersion 和 payload；Java 校验当前绑定，不接受浏览器指定任意文件路径。响应包含 requestId、status、错误码及 authoritative state。所有消息名使用 ccgui.markdown.* 命名空间，避免与原生消息冲突。

| 消息 | 目的 |
| --- | --- |
| ready / init | 版本与能力握手、恢复状态 |
| create / update / delete | 批注写入，带 expectedRevision 防止覆盖他人面板更新 |
| stateChanged | 广播最新批注状态及源文变化 |
| navigate | 使用服务保存的锚点定位源文件 |
| quote / transfer | 加入引用或冻结批次进入目标聊天 |
| result / error | 区分已接收、冲突、过期、无法定位、目标关闭和失败 |

接口具有请求去重。Java 写入成功后 UI 才把操作标为已保存；失败保留输入供重试。Document 读取采用合法 ReadAction；UI 切换与导航通过 EDT；不得在消息回调中同步等待 EDT。

dispose 只撤销本扩展注册的消息订阅、监听及覆盖层，释放 RangeMarker/任务；原生面板和其 BrowserPipe 由 IDE 管理，不由本扩展整体关闭。

### 6.2 选区、源码与文档版本

**先实现块级可靠定位，再补充字符级精确映射。**不能把预览文字 offset 直接当作源 offset，也不能用全文第一个 indexOf 命中替代锚点。

创建锚点时保存：
- annotationId、revision、文件身份、相对路径、时间。
- 原生 renderRevision 和与其对应的 Document 快照 hash/version。
- selectedText、prefix/suffix、源块范围及 Markdown 源片段。
- 精度 exact / block / unresolved；exact 才记录经过验证的字符级范围。
- 位置状态 attached / changed / ambiguous / orphaned；展示行号由正确版本推导。

算法顺序：
1. 捕获 DOM Range 与可见文本、来源块和局部文本偏移，不在点击弹窗后重新读取全局选区。
2. 对照原生源位置元数据确定源块；核实该元数据表示字符、字节还是行号。
3. 精确匹配需处理链接、强调符号、HTML 实体、转义、代码高亮的多节点文本和 emoji；映射失败则保留块级来源及可见引用，并显示精度。
4. 与 Document 的版本绑定。若预览滞后、节点已被重绘或请求来自旧 renderRevision，重新验证或返回过期结果，不能给旧选文贴上新行号。
5. 活动文档用 RangeMarker 跟踪插入/删除；撤销、重做、关闭重开时以源片段和上下文重新校验。
6. 多个可能匹配时显示歧义，原文删除时显示失效；允许重新选择原文绑定。

首版至少保证块级来源可校验、引用精确、状态可见；对于 source metadata 无法定位的选区，不保存一个看似准确的批注。P2 验证报告必须列出支持的元素与定位精度。DOM 包装、高亮样式不能破坏原生编辑/预览同步信息。

### 6.3 原生覆盖层和悬浮弹窗

UI 放在单独的根节点，CSS 命名空间固定，尽量不改写原生正文 DOM；优先用 Range.getClientRects + 覆盖层呈现批注高亮。CSS Highlights API 只有在目标 JCEF 已验证支持时使用。

- 限制选区在原生正文容器内，排除批注弹窗、操作栏和其他扩展 UI。
- 按 selection rect 定位操作栏，边缘自动翻转并夹在视口内；滚动、缩放、分屏 resize 时更新。
- 鼠标点击、键盘选择和倒序选择都可触发；点击操作栏之前保存锚点，弹窗输入不影响原选文。
- 仅重新计算当前可见批注的几何信息，使用 requestAnimationFrame 合并滚动/resize，避免全页高频 TreeWalker。
- Observer 忽略自身覆盖层修改，防止回调循环；原生重绘后从服务状态恢复标记。
- 提供键盘焦点、Esc 取消、可访问名称；IME composition 中不响应确认提交。
- 字体/颜色沿用原生预览及 IDE 主题，批注关闭后恢复原有页面行为。
- 快捷键通过 IDE Action / Keymap 暴露，先核查冲突，不固定照搬截图快捷键。

### 6.4 本地持久化及修订

项目级 PersistentStateComponent 采用工作区存储，模型有 schemaVersion、独立批注修订、批次快照及状态。预览扩展对象本身不负责持久化。[平台状态保存文档](https://plugins.jetbrains.com/docs/intellij/persisting-state-of-components.html)

- 保存原文片段与必要上下文；不为每条批注重复保存整份文档。批次需要全文时按 hash 去重。
- Project / VirtualFile / RangeMarker 等运行对象不序列化；文件重命名/移动通过 VFS 更新持久身份，重启后重新校验。
- 同一文件多面板写入使用 expectedRevision；冲突返回最新状态，不能静默覆盖。
- 服务的状态快照不可变，后台计算不得占用 EDT；项目关闭前完成必要保存。
- 设置保留/清理能力和有限存储策略，超出限额需明确提示；未发送内容不能静默淘汰。
- 损坏数据保留可恢复副本或提供导出错误内容，不能使插件启动失败。

### 6.5 批次、聊天草稿、排队和实际发送

批注服务与聊天草稿之间采用 **冻结快照**：点击加入聊天时固定选中的批注修订及原文。之后编辑源批注，不隐式改变已经交接的草稿；UI 标识“源批注有更新”，用户可以刷新，刷新生成新的快照版本。

~~~text
原生 Markdown 预览
  → BrowserPipe：transfer
  → 项目服务：冻结 reviewBatch（原文、批注修订、快照版本）
  → 固定 targetTabId / sessionGeneration
  → Java→聊天：addArtifactReview(batch)
  → 聊天持久草稿接收并 ACK
  → “N 条批注”展示 + 用户整体要求
  → 点击发送：序列化为完整 text，再进入消息队列或执行发送
  → send_message → SessionHandler → 当前会话 / provider
~~~

这里有两种不同确认：
- draftAck：已加入指定聊天草稿。重试相同 batchId 不重复添加；超时不删除原批次。
- submission 状态：区分在草稿、排队、已交给后端、失败、结果未知。没有后端成功证据时不能显示“模型已收到”。

计划增加 addArtifactReviewFromExternal(project, target, batch) 和 window.addArtifactReview(payload) 专用入口，不逐条调用单槽 addSelectionFromExternal。

聊天具体改动：
- ChatInputBox 增加独立批次展示/选择 API，保留已有用户文字、附件和引用。
- 可移除批次内某条，更新数量；被移除的内容不会发送，源批注仍保存。
- 批注成为输入是否为空的判断条件，避免空整体要求无法发送。
- 在 App 提交入口建立规范化 OutgoingMessage 快照，先展开批注和引用，再执行本地命令判定、排队、输入清理与发送；仅用户输入部分参与斜杠命令识别，引用原文不会触发命令。
- 所有入口（按钮、快捷键、队列）共享同一序列化入口；历史消息和输入历史存最终文本，不存页面内 token。
- 排队期间源批注/输入变化不改变已排队消息，WebView 重载后也可恢复批次。当前消息队列的持久性需检查；若不能恢复，至少保留批次和“是否已提交未知”状态，禁止自动重发。
- 固定目标身份及会话代际；当前标签变化、目标关闭或会话被重置时返回明确错误，用户重新选择目标。
- 依旧使用当前 provider、model、permissionMode 和 busy/interrupt 机制，不直接调用 SDK 或创建额外 writer。
- 幂等保证限定在批次保存/草稿交接；不承诺网络中断时 provider 恰好执行一次。后端结果不明时由用户决定是否重发。

输出 text 至少包含：用户整体要求、文件相对路径、版本/hash、每条批注 ID/修订、原文引用、源片段/必要上下文、位置精度与变化状态、批注正文。文件标签辅助导航，不作为唯一原文来源。提供发送预览和长度预算，超限可选择减少上下文或显式分批，不静默截断批注。首版无须修改各 provider / ai-bridge 协议。

## 7. 开发任务、依赖与退出条件

工作量是单人估算，包含接口验证、实现与联调；依赖 SDK/JBR 及实际 IDE 环境。P0 未通过前不承诺支持范围。

| 阶段 | 开发任务及主要交付 | 必须通过的验证 | 估计 |
| --- | --- | --- | --- |
| P0 原生接入验证 | fetch fork；核实真实 IDE build；查目标发行源码和插件描述；加入可选依赖；实现最小 JS/CSS + ready/echo 原型；记录 API、源码映射元数据、替代接口 | 真正 .md 原生预览中资源被 CSP 允许；双向消息往返；能可靠绑定文件/项目；关闭/重开无残留；禁用 Markdown 后聊天仍正常；明确版本边界 | 1–2 工作日 |
| P1 协议与状态骨架 | PreviewBinding、窄桥接协议、批注服务和持久化、schema；每面板独立代际；构建产物接入 Gradle | 旧页面请求被拒绝；重复请求只写一次；多面板一致；重启恢复；可选依赖无类加载错误；资源确实进入插件 ZIP | 1–2 工作日 |
| P2 原生选区与批注 UI | 选区捕获、块/字符锚点、操作栏、弹窗、CRUD、高亮和标记 | 加粗/链接/中文/emoji/代码/跨块等支持清单；重复文本不误定位；焦点及 IME；原生重绘和滚动同步未受影响 | 2–3 工作日 |
| P3 文档变化恢复 | RangeMarker、版本校验、撤销重做、外部修改、重命名、重新绑定、定位源文 | 未保存编辑与预览一致；滞后预览不产生错误位置；删除/歧义可见；多面板并发修订不覆盖；重开文件恢复 | 1–2 工作日 |
| P4 CC GUI 交接与发送 | ReviewBatchService、固定目标、ACK、幂等、计数/展开/移除、持久草稿、OutgoingMessage 提交快照 | 1/多条批注一次进入正确标签；原有草稿保留；无整体要求可发；排队时冻结完整文本；失败/重载可恢复且不自动重复发送 | 2–3 工作日 |
| P5 全链路与回归 | 真实文件 fixture、IDE集成记录；Claude / Codex 等 provider 验证；输入/队列/中断/历史回归；完善交互与国际化 | 最终 backend payload 与发送预览一致；普通聊天、引用、附件、斜杠命令不退化；原生图片/图表/公式行为保留 | 1–2 工作日 |
| P6 兼容、性能与交付 | 扩展验证矩阵、Plugin Verifier、构建检查、性能测试、使用说明和支持版本表；整理可评审提交 | 无新增不可接受的兼容/内部 API 问题；负面环境安全降级；性能记录及资源释放通过；可安装插件包与验收报告 | 2–3 工作日 |

合计约 **10–17 个工作日**。依赖顺序为 P0 → P1 → P2 → P3 → P4 → P5 → P6。P0 后更新工作量及支持矩阵；后续每个阶段都提交其验证记录，未验证项显式保留。

建议提交单元：原生依赖及资源 → 协议和服务 → 锚点/UI → 文档恢复 → 批次及聊天 → 兼容与交付。推送或提 PR 作为后续开发任务处理。

## 8. 必须验证的清单

### 8.1 环境与兼容矩阵

| 维度 | 验证要求 |
| --- | --- |
| 首要平台 | Windows + 默认 IDEA Community 2024.3.1/build 243；同时确定用户实际 IDE/build，以真实安装版本作为第二条主线 |
| IDE 产品 | IDEA、WebStorm、PyCharm、Rider 的代表版本；插件依赖及预览实现逐产品确认 |
| 平台年代 | 最低声明 build 233、243、253、261、262，以及 263 仅在相应 SDK/发行版本可用时验证；没测不能列为支持 |
| 依赖状态 | Markdown 启用/禁用/未安装；原生预览可用/不可用；getBrowserPipe 或文件绑定为 null |
| UI 与运行模式 | 编辑+预览/仅预览、多编辑器拆分、同文档多预览；深浅主题、缩放、窄窗口、Windows/macOS/Linux |
| 远程开发 | Gateway/Remote Development 若有前后端分离，单独验证服务位置与传输；首版未测则标为未支持 |
| 检查工具 | 新增当前 Verifier 之外的代表 build；区别 API obsolete/experimental 状态与实际 verifier 结果；记录完整 build、Markdown 插件版本及 JBR |

未通过原生接入的环境关闭批注入口、说明当前条件；IDE 的原生预览和 CC GUI 聊天继续使用。不给未测环境生成看似可用的入口。

### 8.2 关键用例与通过条件

| 编号 | 类别 | 实测场景 | 通过条件 |
| --- | --- | --- | --- |
| V01 | 原生功能保持 | 图片、链接、目录、代码、Mermaid/公式及源码同步 | 对比扩展启用前后，原生行为保持，扩展不接管或重建渲染 |
| V02 | 文本选择 | 倒序/键盘/跨段落、强调/链接/代码/表格 | 准确引用，来源精度正确；不支持项明确提示 |
| V03 | 偏移语义 | 中文、emoji、组合字符、实体、转义、LF/CRLF | DOM 与 Document 偏移单位经过 fixture 证明，范围与行号无偏差 |
| V04 | 批注 CRUD | 新建、取消、空内容、编辑、删除、重叠选区 | UI、存储和计数一致，取消不写数据，旧修订更新返回冲突 |
| V05 | 预览延迟/重绘 | 编辑后未完成渲染时添加；原生局部重绘/全刷新 | 旧 renderRevision 被识别；不重复绑定监听，标记恢复且位置正确 |
| V06 | 文件演进 | 头部插入、整段删除、重复文本、撤销重做、外部重写、重命名 | 位置可恢复；歧义/失效保留原快照并展示状态，不误绑定另一处同文 |
| V07 | UI/IME | 点击操作栏、靠边/滚动/缩放、中文组合输入/快捷键 | 焦点与原文引用稳定，IME期间不误提交，弹窗及快捷键可操作 |
| V08 | 持久化/多面板 | 重启、损坏存储、同文档两面板编辑旧修订 | 数据恢复；损坏状态不影响启动；多面板一致且冲突明确 |
| V09 | 初始化/传输 | 聊天未开/未就绪、ACK丢失、重复点击、超时重试 | 批次原子加入一次；没收到ACK保留内容，重试不增加副本 |
| V10 | 多会话 | 投递中切标签、关闭目标、重置会话、不同项目同文件名 | 固定目标；无效目标保留批次并重新选择；项目之间不串数据 |
| V11 | 草稿/排队 | 既有输入和附件、删一条批注、无用户文字、AI忙碌；排队后改源批注/清理registry | 入队文本完整冻结，删除和计数一致，原有输入不被覆盖 |
| V12 | 发送故障 | 后端拒绝、网络失败、页面重载、未知提交结果 | 明确区分失败与未知，内容可恢复，不自动重复提交模型 |
| V13 | 文本边界 | 原文含反引号/HTML/脚本/斜杠命令、超长批注、伪造文件/旧面板请求 | 以文本编码，引用不触发本地命令，超限提示，受控桥拒绝任意请求 |
| V14 | 生命周期 | 关闭编辑器/项目、切预览模式、反复开关文件、扩展禁用 | 只释放本扩展对象和订阅，无残留覆盖层、定时器、监听或失效面板引用 |

### 8.3 性能与自动化分层

样本：约 200 KB 和 2 MB Markdown、0/10/100 条批注，包含长代码块、重复段落及大表格。记录机器、IDE/JBR、是否启用其他 Markdown 扩展、测量方式和基线。

初始性能目标：200 KB / 100 批注下，选文结束到显示操作栏 p95 ≤ 100 ms、滚动覆盖层更新 p95 ≤ 32 ms；最终阈值在 P0/P2 实测基线后确认。2 MB 文档允许限制交互，但必须明确提示；不能每次滚动整页解析或重算全部批注。反复开关预览后，不保留本扩展的 panel binding / DOM监听 / 定时器，持续内存增长需检查引用链。

- JUnit：锚点恢复、版本/修订检查、批次幂等、目标代际、持久化、序列化与边界。
- Vitest：DOM选区与几何逻辑、弹窗状态、原生消息模拟、chat批次操作、OutgoingMessage冻结。
- Playwright：以原生DOM fixture 验证选文到草稿交互；只能说明浏览器逻辑通过。
- 实际 runIde：真实 Markdown plugin/JCEF/CSP、BrowserPipe、原生重绘、文件监听、跨面板与聊天路径。
- Provider：先捕获本地最终请求payload，再实测 Claude / Codex；另一个 provider至少验证共享路径的 payload，不只测试渲染结果。
- 构建：前端及 Java 必要测试、checkstyleMain、buildPlugin、Plugin Verifier。P0增加原生依赖后确认真实命令和targetIde参数；不为计划修改运行这些检查。

## 9. 完成定义与交付物

核心验收：在 IDE 自带预览中选两段文字添加批注，编辑一条，删除/重建另一条；点击加入指定 CC GUI 标签，看到“2 条批注”，补充整体要求并发送。实际后端接收同一条包含两段原文、文件/快照、准确位置或块级/失效说明、最终批注及要求的消息。原生 Markdown 显示与源码同步保持原有行为。

另外必须通过：未保存编辑、原生重绘、文件重开/IDE重启恢复、目标切换/关闭、批次重复投递、忙碌会话排队，以及失败后恢复。

交付物：

1. 可安装的插件包、功能代码与必要测试。
2. 版本/IDE/JBR/Markdown兼容表，原生接口验证记录及受限场景。
3. 锚点 fixture、端到端实际payload证据、性能与生命周期结果。
4. 用户操作说明：批注、引用、加入聊天、更新快照、失效及重试。
5. 变更说明与可评审提交；明确列出尚未验证的平台或能力。

当前首版代码和原生集成已完成；下一阶段按第 0 节未验证项推进兼容、真实 provider 回执与失败恢复、复杂选区和性能测试。P0–P6 表是完整路线，具体完成证据以第 0 节为准。

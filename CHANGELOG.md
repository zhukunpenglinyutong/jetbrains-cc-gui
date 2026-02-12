##### **2026年2月12日（v0.1.8）**

English:

✨ Features
- Add Claude Opus 4.6 model support with 1M context window
- Add preset buttons for quick provider configuration with one-click setup
- Integrate Claude and Codex provider management with unified tab interface
- Enhance DevTools action with Chrome remote debugging support
- Change file click behavior in status panel and restore diff icon
- Update Codex SDK to latest version
- Add exception error notification for better user feedback

🐛 Fixes
- Fix MCP SSE transport verification and tools retrieval
- Fix MCP STDIO server verification and improve protocol compliance
- Fix SSE endpoint and error handling issues
- Truncate long error messages to prevent webview freezing
- Preserve cursor position after dropdown selection and file-tag rendering
- Exclude cache read tokens from context window usage calculation
- Disable immediate tab creation to fix tab loading stuck issue
- Improve mermaid rendering on history load
- Use #app rect as reference for fixed positioning in zoom container
- Retrieve user-selected changes via reflection for diff operations
- Fix compile encoding on Windows

🔧 Improvements
- Change license from AGPL-3.0 to MIT for broader compatibility
- Add i18n support for provider presets and optimize rendering
- Filter environment keys in local provider and optimize model mapping
- Refactor reflection to safely handle collections
- Fix ErrorBoundary timer cleanup to prevent memory leaks
- Extract sponsors list to SPONSORS.md and simplify README
- Add Trendshift badge to README files

中文：

✨ Features
- 新增 Claude Opus 4.6 模型支持，提供 1M 上下文窗口
- 新增供应商预设按钮，支持一键快速配置
- 整合 Claude 和 Codex 供应商管理，统一标签页界面
- 增强 DevTools 操作，支持 Chrome 远程调试
- 修改状态面板文件点击行为，恢复 Diff 图标
- 更新 Codex SDK 到最新版本
- 新增异常错误通知，提供更好的用户反馈

🐛 Fixes
- 修复 MCP SSE 传输验证和工具获取问题
- 修复 MCP STDIO 服务器验证，改进协议兼容性
- 修复 SSE 端点和错误处理问题
- 截断长错误消息，防止 webview 冻结
- 修复下拉选择和文件标签渲染后的光标位置保持
- 从上下文窗口使用量计算中排除缓存读取的 token
- 禁用立即创建标签页，修复标签页加载卡住问题
- 改进历史记录加载时的 mermaid 渲染
- 使用 #app rect 作为缩放容器中固定定位的参考
- 通过反射获取用户选择的更改用于 Diff 操作
- 修复 Windows 下的编译编码问题

🔧 Improvements
- 许可证从 AGPL-3.0 更改为 MIT，提升兼容性
- 为供应商预设添加国际化支持，优化渲染性能
- 过滤本地供应商中的环境变量键，优化模型映射
- 重构反射以安全处理集合类型
- 修复 ErrorBoundary 定时器清理，防止内存泄漏
- 提取赞助商列表到 SPONSORS.md，简化 README
- 在 README 中添加 Trendshift 徽章

##### **2026年2月5日（v0.1.7-beta5）**

English:

✨ Features
- Add message queue functionality: auto-queue messages when AI is processing, with queue UI above input box
- Add 5-minute timeout countdown to AskUserQuestionDialog and PlanApprovalDialog with 30-second warning banner
- Add collapse/expand functionality for permission dialogs
- Add history item editor with importance settings in OtherSettingsSection
- Add attachment block support for file chips display
- Add "Auto Open File" toggle to control ContextBar display and AI context collection
- Add history deep search feature: clears cache and reloads all session data from filesystem

🐛 Fixes
- Fix tool icon width and alignment in MCP settings
- Fix line separator handling in diff view to prevent "Wrong line separators" errors
- Fix token usage calculation for different providers (Codex/OpenAI vs Claude cache handling)
- Fix useEffect dependency issues in dialog components
- Fix potential timer memory leaks with improved cleanup logic
- Fix autoOpenFile setting to properly control AI editor context collection

🔧 Improvements
- Refactor: use centralized path utilities for homedir resolution (fix Windows symlink issues)
- Refactor: extract line separator handling to LineSeparatorUtil
- Refactor: replace CSS gap property with margin-right pattern for better browser compatibility
- Refactor: extract common LESS mixins to reduce code duplication (~254 lines reduced)
- Refactor: remove SlashCommandCache class, fetch slash commands directly from SDK
- Add Map cache size limit (100 entries) to prevent memory growth
- Add OpenAI/Codex model context limits (GPT-5.x, o3, o1 series)
- Add webfetch to collapsible tools list in GenericToolBlock
- Add frontend data validation for usage percentage
- Extract formatCountdown as shared utility function
- Add comprehensive i18n support for new dialog features

中文：

✨ Features
- 新增消息队列功能：AI 处理时自动排队新消息，队列 UI 显示在输入框上方
- 新增 AskUserQuestionDialog 和 PlanApprovalDialog 的 5 分钟超时倒计时，剩余 30 秒时显示警告横幅
- 新增权限对话框折叠/展开功能
- 新增历史项编辑器，支持重要性设置（在其他设置中）
- 新增附件块支持，用于文件标签显示
- 新增"自动打开文件"开关，控制 ContextBar 显示和 AI 上下文收集
- 新增历史深度搜索功能：清除缓存并从文件系统重新加载所有会话数据

🐛 Fixes
- 修复 MCP 设置中工具图标宽度和对齐问题
- 修复 Diff 视图中行分隔符处理问题，防止"Wrong line separators"错误
- 修复不同供应商的 token 使用量计算（Codex/OpenAI vs Claude 缓存处理）
- 修复对话框组件中的 useEffect 依赖问题
- 修复定时器内存泄漏问题，改进清理逻辑
- 修复 autoOpenFile 设置对 AI 编辑器上下文收集的控制

🔧 Improvements
- 重构：使用集中式路径工具函数解析 homedir（修复 Windows 符号链接问题）
- 重构：提取行分隔符处理到 LineSeparatorUtil
- 重构：用 margin-right 模式替换 CSS gap 属性，提升浏览器兼容性
- 重构：提取公共 LESS mixins 减少代码重复（约减少 254 行）
- 重构：移除 SlashCommandCache 类，直接从 SDK 获取斜杠命令
- 添加 Map 缓存大小限制（100 条）防止内存增长
- 添加 OpenAI/Codex 模型上下文限制（GPT-5.x、o3、o1 系列）
- 在 GenericToolBlock 添加 webfetch 到可折叠工具列表
- 添加前端使用百分比数据验证
- 提取 formatCountdown 为共享工具函数
- 为新对话框功能添加完整的国际化支持

##### **2026年1月31日（v0.1.7-beta4）**

English:

✨ Features
- Add input history recording with Tab key completion and configurable settings toggle
- Add persistent storage for input history in ~/.codemoss/inputHistory.json with management UI in settings
- Add interactive Diff view with Apply/Reject buttons and state persistence across sessions
- Add local handling for new session commands (/clear, /new, /reset) to bypass confirmation dialog
- Add disk cache for slash commands with 7-day TTL and preload on component mount

🐛 Fixes
- Fix placeholder text filtering when uploading images (avoid "已上传附件:" in content)
- Fix user message copy button position overlap issue
- Fix stale input values during submission by adding cancelPendingInput
- Fix stdin handling for parameter passing in node scripts
- Fix attachment placeholder i18n (replace hardcoded Chinese with standardized English format)
- Fix new file rejection in diff view: delete file instead of restoring empty content

🔧 Improvements
- Extract completion trigger detection to dedicated useCompletionTriggerDetection hook
- Improve history completion code quality: add MAX_COUNT_RECORDS limit, custom event sync, boundary checks
- Improve chat input hover and resize handle interactions with border glow effect
- Extract reusable CopyButton component from duplicate implementations
- Refactor diff utilities: extract DiffBrowserBridge and ContentRebuildUtil classes
- Add path security validation with isPathWithinProject method and improved traversal detection
- Increase input box min-height from 3 lines to 4 lines
- Add comprehensive i18n support for history management and diff operations

中文：

✨ Features
- 新增输入历史记录功能，支持 Tab 键补全，可在设置中自由开关
- 新增输入历史持久化存储（~/.codemoss/inputHistory.json），设置页面支持历史管理 UI
- 新增交互式 Diff 视图，支持 Apply/Reject 按钮和跨会话状态持久化
- 新增本地会话命令处理（/clear、/new、/reset），跳过确认对话框直接创建新会话
- 新增斜杠命令磁盘缓存（7天 TTL），组件挂载时预加载

🐛 Fixes
- 修复上传图片时占位符文本过滤问题（避免内容中出现"已上传附件:"）
- 修复用户消息复制按钮位置遮挡问题
- 修复输入提交时的过期值问题，添加 cancelPendingInput 机制
- 修复 node 脚本中 stdin 参数传递处理
- 修复附件占位符国际化问题（将硬编码中文替换为标准化英文格式）
- 修复 Diff 视图中新文件拒绝操作：删除文件而非恢复空内容

🔧 Improvements
- 重构补全触发检测到独立 hook（useCompletionTriggerDetection）
- 改进历史补全代码质量：添加 MAX_COUNT_RECORDS 限制、自定义事件同步、边界检查
- 改进输入框悬停和调整大小手柄交互，添加边框发光效果
- 提取可复用的 CopyButton 组件，消除重复实现
- 重构 Diff 工具类：提取 DiffBrowserBridge 和 ContentRebuildUtil 类
- 添加路径安全验证（isPathWithinProject 方法）和改进的路径遍历检测
- 输入框最小高度从 3 行增加到 4 行
- 为历史管理和 Diff 操作添加完整的国际化支持

##### **2026年1月30日（v0.1.7-beta3）**

English:

✨ Features
- Add tab answering status indicator with multi-state support (ANSWERING, COMPLETED, IDLE) and auto-reset
- Add copy server config button for MCP servers with clipboard integration and env/headers sanitization
- Improve MCP server discovery: expose disabled and invalid servers alongside enabled ones
- Merge global and project MCP server configurations for complete status display
- Enhance PATH with ~/.local/bin and ~/.cargo/bin for uvx/cargo tool resolution

🐛 Fixes
- Fix EDT thread safety in tab status auto-reset callback
- Fix loading state sync during streaming (check before sending event)
- Fix chat input box border-radius selector for resize handles
- Sanitize environment variables and headers when copying MCP server config
- Remove unused cacheKeys prop from ServerCard

🔧 Improvements
- Replace boolean loading state with TabAnswerStatus enum for richer status display
- Replace inline MCP log panel with dialog for cleaner UI
- Relax command whitelist to warn instead of block user-configured servers
- Add marker-based output parsing for Java-side process communication with early termination
- Replace refresh icon with sync icon and unify icon button styling across MCP components
- Reduce log verbosity (info → debug) for tab status events
- Use language-neutral "..." suffix for answering state
- Add mobile responsive styles for MCP header buttons
- Remove per-server refresh button for cleaner UI
- Add internationalization support for tab status messages

中文：

✨ Features
- 新增标签页回答状态指示器，支持多状态显示（回答中、已完成、空闲）并自动重置
- 新增 MCP 服务器配置复制按钮，支持剪贴板集成并自动清理敏感的环境变量和请求头
- 改进 MCP 服务器发现：展示已禁用和无效的服务器完整状态
- 合并全局和项目级 MCP 服务器配置，提供完整状态展示
- 增强 PATH 环境变量，添加 ~/.local/bin 和 ~/.cargo/bin 以支持 uvx/cargo 工具解析

🐛 Fixes
- 修复标签页状态自动重置回调中的 EDT 线程安全问题
- 修复流式传输期间加载状态同步问题（发送事件前先检查状态）
- 修复聊天输入框 border-radius 选择器对调整手柄的影响
- 复制 MCP 服务器配置时自动清理环境变量和请求头中的敏感信息
- 移除 ServerCard 中未使用的 cacheKeys 属性

🔧 Improvements
- 用 TabAnswerStatus 枚举替换布尔加载状态，支持更丰富的状态展示
- 用对话框替换内联 MCP 日志面板，界面更简洁
- 放宽命令白名单限制，对用户配置的服务器改为警告而非阻止
- Java 端进程通信添加基于标记的输出解析，支持提前终止
- 统一 MCP 组件图标按钮样式，用同步图标替换刷新图标
- 降低标签页状态事件日志级别（info → debug）
- 回答状态使用语言无关的 "..." 后缀
- 新增 MCP 头部按钮的移动端响应式样式
- 移除每个服务器的独立刷新按钮，简化界面
- 添加标签页状态消息的国际化支持

##### **2026年1月28日（v0.1.7-beta2）**

English:

✨ Features
- Add MCP server tools fetching and caching system with STDIO and HTTP/SSE support
- Add resizable chat input box with vertical resize handles and localStorage persistence
- Add copy button for user messages with performance optimization
- Add project-specific MCP configuration support

🐛 Fixes
- Fix chat input box horizontal resize bug that caused width collapse
- Fix loading panel removal causing close confirmation dialog race condition
- Fix XSS vulnerability in file tag rendering with proper text escaping
- Fix memory leak in copy button timeout cleanup
- Fix FileReader error handling for file operations

🔧 Improvements
- Refactor ChatInputBox into modular components (header, footer, resize handles)
- Optimize large text handling with array+join (6+ seconds → <100ms for 50KB text)
- Add performance instrumentation with configurable thresholds and timing marks
- Improve security with delegated event handlers to prevent listener leaks
- Add text length thresholds to skip expensive operations (10K/50K/5K chars)
- Limit max file tags per render to 50 to prevent UI freeze
- Create centralized performance constants module (constants/performance.ts)
- Improve accessibility for resize handles with ARIA roles and keyboard support
- Add tools cache manager with expiry configuration for MCP servers
- Create React hooks for MCP tools update and management (useToolsUpdate, useServerData, useServerManagement)
- Refactor MCP status service into modular architecture (13+ new modules)
- Add comprehensive TypeScript type definitions for MCP components
- Reduce native listener re-subscriptions in ChatInputBox hooks
- Replace string concatenation with array+join in file tags and text content extraction
- Use fast Range API for text insertion >5K chars instead of slow execCommand

中文：

✨ Features
- 新增 MCP 服务器工具获取和缓存系统，支持 STDIO 和 HTTP/SSE 协议
- 新增聊天输入框垂直调整大小功能，支持 localStorage 持久化
- 新增用户消息复制按钮，带性能优化
- 新增项目特定 MCP 配置支持

🐛 Fixes
- 修复聊天输入框水平调整导致宽度崩溃的问题
- 修复加载面板移除导致关闭确认对话框竞态条件的问题
- 修复文件标签渲染中的 XSS 漏洞，正确转义文本
- 修复复制按钮超时清理的内存泄漏问题
- 修复 FileReader 文件操作错误处理

🔧 Improvements
- 重构 ChatInputBox 为模块化组件（header、footer、resize handles）
- 优化大文本处理，使用数组+join（50KB 文本粘贴从 6+ 秒优化至 <100ms）
- 添加性能监控工具，支持可配置阈值和计时标记
- 改进安全性，使用委托事件处理器防止监听器泄漏
- 添加文本长度阈值跳过昂贵操作（10K/50K/5K 字符）
- 限制每次渲染最多 50 个文件标签，防止 UI 冻结
- 创建集中式性能常量模块（constants/performance.ts）
- 改进调整大小手柄的可访问性，支持 ARIA 角色和键盘操作
- 添加 MCP 服务器工具缓存管理器，支持过期配置
- 创建 MCP 工具更新和管理的 React hooks（useToolsUpdate、useServerData、useServerManagement）
- 重构 MCP 状态服务为模块化架构（新增 13+ 个模块）
- 添加 MCP 组件的完整 TypeScript 类型定义
- 减少 ChatInputBox hooks 中的原生监听器重新订阅
- 在文件标签和文本内容提取中用数组+join 替换字符串拼接
- 对超过 5K 字符的文本插入使用快速 Range API 替代缓慢的 execCommand

##### **2026年1月28日（v0.1.7-beta1）**

English:

✨ Features
- Add chat input history navigation with ArrowUp/ArrowDown keys
- Add tab rename and close confirmation features
- Add AI-powered commit message generation
- Add Codex SDK image attachment support

🐛 Fixes
- Fix MCP connection failure issue
- Fix MCP invocation issue on Windows

🔧 Improvements
- Refactor ChatInputBox into modular hooks
- Improve custom model input validation and security
- Improve Action classes thread safety

中文：

✨ Features
- 聊天输入框支持上下箭头键历史记录导航
- 支持标签页重命名和关闭确认
- AI 智能生成 Git 提交消息
- Codex SDK 支持图片附件

🐛 Fixes
- 修复 MCP 连接失败问题
- 修复 Windows 系统 MCP 无法调用的问题

🔧 Improvements
- 重构 ChatInputBox 组件，拆分为独立 hooks
- 改进自定义模型输入验证和安全性
- Action 类线程安全性优化

##### **2026年1月25日（v0.1.6）**

English:
- [x] Add custom "Other" option to AskUserQuestion dialog with textarea for custom input
- [x] Auto-detect fnm (Fast Node Manager) nodejs path (#265)
- [x] Fix npm package specs quoting to preserve semver operators (^~><) on Windows (#258)
- [x] Fix macOS JCEF zoom/layout recovery after resume (#248)
- [x] Fix MCP plugin connection and invocation issues (#266)
- [x] Extract shell execution logic to ShellExecutor utility class for better reusability
- [x] Use toast notifications for error messages with type-based duration (error: 5s, warning: 3s, default: 2s)
- [x] Improve MCP status service security: command whitelist validation, unified logging, reusable functions
- [x] Add ReDoS protection with line length limits in mcp-status-service
- [x] Replace regex-based JSON parsing with bracket matching algorithm for better security
- [x] Add input length limits in AskUserQuestionDialog
- [x] Improve NpmPermissionHelper with precompiled regex and quote escaping
- [x] Extract Toast duration constants for better maintainability
- [x] Add i18n translations for "Other" option (en, es, fr, hi, ja, zh, zh-TW)
- [x] Change cancel button text to "Auto" across all languages

中文:
- [x] 在 AskUserQuestion 对话框中添加自定义 "Other" 选项，支持文本输入
- [x] 自动检测 fnm（快速 Node 管理器）的 nodejs 路径 (#265)
- [x] 修复 Windows 上 npm 包规格引用问题，保留 semver 操作符（^~><）(#258)
- [x] 修复 macOS JCEF 休眠恢复后的缩放/布局问题 (#248)
- [x] 修复 MCP 插件无法正常连接调用的问题 (#266)
- [x] 提取 shell 执行逻辑到 ShellExecutor 工具类，提升代码复用性
- [x] 使用 toast 通知替代错误消息，根据类型设置显示时长（错误: 5秒，警告: 3秒，默认: 2秒）
- [x] 改进 MCP 状态服务安全性：命令白名单验证、统一日志系统、提取可复用函数
- [x] 在 mcp-status-service 中添加 ReDoS 防护，限制行长度
- [x] 用括号匹配算法替换基于正则的 JSON 解析，提升安全性
- [x] 在 AskUserQuestionDialog 中添加输入长度限制
- [x] 改进 NpmPermissionHelper，添加预编译正则和引号转义
- [x] 提取 Toast 显示时长常量，提升可维护性
- [x] 为 "Other" 选项添加多语言翻译（en、es、fr、hi、ja、zh、zh-TW）
- [x] 将取消按钮文本统一更改为 "Auto"

##### **2026年1月24日（v0.1.6-beta3）**

English:
- [x] Add StatusPanel with task tracking, subagent status, and file changes undo
- [x] Add session index cache system with in-memory caching (5min TTL) and disk persistence
- [x] Add BashToolGroupBlock for batch command display with timeline view
- [x] Extract and display command-message tag content from user input
- [x] Extract settings state management into custom hooks (useProviderManagement, useCodexProviderManagement, useAgentManagement)
- [x] Add useIsToolDenied shared hook to reduce code duplication
- [x] Add useFileChanges hook with single/batch undo support
- [x] Add useSubagents hook for background task status tracking
- [x] Fix cursor position preservation during input value sync and file tag rendering
- [x] Fix permission handling issues (JSON parse error handling, stale state cleanup, React safety)
- [x] Fix BashToolGroupBlock expanded item scrolling by increasing max-height
- [x] Fix BridgeDirectoryResolver filesystem sync race condition
- [x] Refactor: remove duplicate LOG.info/debugLog calls in permission services
- [x] Refactor: extract permission timeout as named constants with cross-reference comments
- [x] Clean up frontend console logs

中文:
- [x] 新增状态面板（StatusPanel）：支持任务跟踪、子代理状态显示和文件变更撤销
- [x] 新增会话索引缓存系统：内存缓存（5分钟 TTL）+ 磁盘持久化
- [x] 新增批量命令显示组件（BashToolGroupBlock）：支持时间线视图
- [x] 提取并显示用户输入中的 command-message 标签内容
- [x] 提取设置状态管理到自定义 hooks（useProviderManagement、useCodexProviderManagement、useAgentManagement）
- [x] 新增 useIsToolDenied 共享 hook，减少代码重复
- [x] 新增 useFileChanges hook，支持单个/批量撤销功能
- [x] 新增 useSubagents hook，用于后台任务状态跟踪
- [x] 修复输入框光标位置：输入值同步和文件标签渲染时保持光标位置
- [x] 修复权限处理问题（JSON 解析错误处理、过期状态清理、React 安全性）
- [x] 修复 BashToolGroupBlock 展开项滚动问题
- [x] 修复 BridgeDirectoryResolver 文件系统同步竞态条件
- [x] 重构：移除权限服务中的重复 LOG.info/debugLog 调用
- [x] 重构：提取权限超时为命名常量并添加交叉引用注释
- [x] 清理前端 console.log 语句

##### **2026年1月22日（v0.1.6-beta2）**

English:
- [x] Add terminal support and enhance terminal monitoring features
- [x] Add keyboard shortcuts for Quick Fix action
- [x] Add RunConfigMonitorService to monitor Run/Debug service output
- [x] Add dev mode detection and DevTools support
- [x] Add Follow IDE theme option with reliable theme detection
- [x] Add permission isolation per IDE session
- [x] Filter @ file search results with .gitignore rules
- [x] Add mermaid diagram rendering support
- [x] Add send file path to CCG from project tree context menu
- [x] Add sponsor section to settings with i18n support
- [x] Fix Codex usage updates from result messages
- [x] Fix: remove redundance in terminal output
- [x] Fix: inject IDE theme at HTML load time to prevent flash
- [x] Fix: downgrade Claude SDK to v0.2.3
- [x] Fix: defer run-config monitoring to EDT
- [x] Refactor: improve code quality, memory management, and security
- [x] Refactor: improve PermissionService code quality

中文:
- [x] 添加终端支持并增强终端监控功能
- [x] 添加 Quick Fix 操作的键盘快捷键
- [x] 添加 RunConfigMonitorService 监控 Run/Debug 服务输出
- [x] 添加开发模式检测和 DevTools 支持
- [x] 添加跟随 IDE 主题选项，支持可靠的主题检测
- [x] 实现每个 IDE 会话的权限隔离
- [x] 根据 .gitignore 规则过滤 @ 文件搜索结果
- [x] 添加 mermaid 图表渲染支持
- [x] 添加从项目树右键菜单发送文件路径到 CCG 功能
- [x] 在设置中添加赞助商部分（支持国际化）
- [x] 修复 Codex 使用量统计更新问题
- [x] 修复终端输出中的冗余内容
- [x] 修复 HTML 加载时注入 IDE 主题以防止闪烁
- [x] 修复：降级 Claude SDK 到 v0.2.3
- [x] 修复：将 run-config 监控推迟到 EDT
- [x] 重构：改进代码质量、内存管理和安全性
- [x] 重构：改进 PermissionService 代码质量

##### **2026年1月19日（v0.1.6-beta1）**

English:
- [x] Fix dialog appearing in wrong IDEA window when multiple instances are open
- [x] Enable streaming responses by default for smoother experience
- [x] Fix session state occasionally becoming abnormal
- [x] Use system native save dialog when exporting sessions
- [x] Fix settings tab losing input when switching tabs
- [x] Fix usage statistics accuracy
- [x] Fix custom Node.js path compatibility issue

中文:
- [x] 修复多开IDEA时，弹窗可能跑到其他IDEA窗口的问题
- [x] 默认开启流式回复，响应更流畅
- [x] 修复会话状态偶尔异常的问题
- [x] 导出会话时使用系统原生保存对话框
- [x] 修复切换设置页签时丢失已填写内容的问题
- [x] 修复使用统计不准确的问题
- [x] 修复自定义Node.js路径的兼容性问题

##### **2026年1月17日（v0.1.5）**

English:
- [x] Add batch grouping for consecutive Read and Edit tool blocks
- [x] Add status message notifications for reconnection and other status info
- [x] Add automatic retries mechanism
- [x] Add Codex MCP server management (CRUD operations)
- [x] Enhance Codex integration with file context injection (@ references)
- [x] Support active file content auto-injection for Codex
- [x] Add AGENTS.md instruction collection support for Codex
- [x] Filter Codex session history by current project path
- [x] Add acceptEdits permission mode for Codex auto-edit approval
- [x] Auto-expand latest thinking block during streaming
- [x] Enhance TodoPanel with current task title and stopped state display
- [x] Add WebSearch to collapsible tool blocks
- [x] Fix MCP popups display issue
- [x] Fix AskUserQuestion tool result handling
- [x] Fix UUID sync for user messages and filesystem I/O timing issue
- [x] Resolve race condition in bridge extraction and improve path handling
- [x] Improve Windows sandbox compatibility (use danger-full-access on Windows)
- [x] Handle JCEF remote mode NPE with dedicated error panel
- [x] Unify tool status indicator styles and layout adjustments
- [x] Support local.properties to specify JDK and Node paths
- [x] Decompose App.tsx into modular components and hooks (2652 → 306 lines)
- [x] Decompose ChatInputBox into modular hooks architecture (8 custom hooks)
- [x] Replace deprecated execCommand with modern Selection API
- [x] Optimize chat interface performance with smart object reuse
- [x] Add multi-level caching and content-visibility optimization
- [x] Add OpenCode provider option
- [x] Improve UI/UX and enhance i18n support

中文:
- [x] 新增连续Read和Edit工具块的批量分组显示
- [x] 新增状态消息通知（重连等状态信息）
- [x] 新增自动重试机制
- [x] 新增Codex MCP服务器管理（增删改查）
- [x] 增强Codex文件上下文注入（支持@引用）
- [x] 支持Codex自动注入当前活动文件内容
- [x] 支持Codex的AGENTS.md指令集合
- [x] 按当前项目路径过滤Codex会话历史
- [x] 新增Codex自动编辑审批的acceptEdits权限模式
- [x] 流式输出时自动展开最新的思考块
- [x] 增强TodoPanel显示当前任务标题和停止状态
- [x] WebSearch加入可折叠工具块
- [x] 修复MCP弹窗显示问题
- [x] 修复AskUserQuestion工具结果处理
- [x] 修复用户消息UUID同步和文件系统I/O时序问题
- [x] 解决bridge解压竞态条件并改进路径处理
- [x] 改进Windows沙箱兼容性（Windows使用danger-full-access模式）
- [x] 处理JCEF远程模式空指针，提供专用错误面板和引导
- [x] 统一工具状态指示器样式和布局调整
- [x] 支持local.properties指定JDK和Node路径
- [x] 重构App.tsx为模块化组件和hooks（2652行→306行）
- [x] 重构ChatInputBox为模块化hooks架构（8个自定义hooks）
- [x] 用现代Selection API替换已废弃的execCommand
- [x] 优化聊天界面性能（智能对象复用）
- [x] 添加多级缓存和content-visibility优化
- [x] 新增OpenCode供应商选项
- [x] 改进UI/UX并增强国际化支持

##### **2026年1月13日（v0.1.5-beta4）**

English:
- [x] Add experimental PyCharm support with Python semantic context collection #pycharm
- [x] Add Codex reasoning effort selector with responsive UI improvements #codex
- [x] Add configurable send shortcut for chat input (Ctrl+Enter / Cmd+Enter)
- [x] Add copy message button for assistant responses
- [x] Fix ai-bridge extraction waiting mechanism improvement
- [x] Fix ai-bridge localization issues
- [x] Adjust Codex button container query breakpoint for better responsiveness
- [x] Update Codex reasoning effort levels

中文:
- [x] 添加实验性 PyCharm 支持，支持 Python 语义上下文收集
- [x] 添加 Codex 推理努力程度选择器，优化响应式 UI
- [x] 添加可配置的发送快捷键（Ctrl+Enter / Cmd+Enter）
- [x] 添加助手回复的复制消息按钮
- [x] 修复 ai-bridge 解压等待机制
- [x] 修复 ai-bridge 国际化问题
- [x] 调整 Codex 按钮容器查询断点，提升响应式体验
- [x] 更新 Codex 推理努力程度级别

##### **2026年1月11日（v0.1.5-beta3）**
English:
- [x] Implement Quick Fix feature with Claude integration (right-click context menu)
- [x] Add npm permission issue detection and auto-fix mechanism with retry support
- [x] Add nvmd (Node Version Manager Desktop) support and custom Node.js path configuration
- [x] Improve tab management: rename tabs to sequential format (AI1, AI2, etc.), add "New Tab" button
- [x] Prevent closing the last tab in tool window
- [x] Pass agent prompt per-tab instead of using global setting
- [x] Add response size guard (1MB limit) to prevent regex issues
- [x] Fix Windows package aiBridge issue
- [x] Fix SDK process error display
- [x] Fix Quick Fix timing and Settings streaming state synchronization issues
- [x] Rename "Quick Fix with Claude" to "Ask Claude Code GUI" with i18n support (8 languages)

中文:
- [x] 实现标签页管理（多开AI功能），添加"新建标签页"按钮
- [x] 实现Quick Fix功能与Claude集成（右键上下文菜单）
- [x] 添加npm权限问题检测和自动修复机制，支持重试
- [x] 添加nvmd（Node版本管理器桌面版）支持和自定义Node.js路径配置
- [x] 防止关闭工具窗口中的最后一个标签页
- [x] 每个标签页独立使用各自选择的智能体，而非全局设置
- [x] 添加响应大小限制（1MB）以防止正则表达式问题
- [x] 修复Windows打包aiBridge问题
- [x] 修复SDK进程错误显示问题
- [x] 修复Quick Fix时序和Settings流式状态同步问题
- [x] 将"Quick Fix with Claude"重命名为"Ask Claude Code GUI"，支持8种语言国际化

##### **2026年1月10日（v0.1.5-beta2）**

English:
- [x] Add streaming transmission toggle switch (Claude Code)
- [x] Add local settings.json provider option with i18n support
- [x] Implement SDK lazy loading architecture with concurrency control
- [x] Add Claude getMcpServerStatus API
- [x] Add JCEF support check and improve input handling
- [x] Improve ai-bridge caching and cleanup mechanism
- [x] Improve IME input handling and UI feedback
- [x] Fix Unix permissions preservation during extraction
- [x] Replace native title tooltips with custom CSS tooltips
- [x] Move vConsole button to top-left corner
- [x] Add contributing guidelines (CONTRIBUTING.md)
- [x] Refactor README with dual AI engine features description
- [x] Improve security and performance optimizations

中文:
- [x] 增加流式传输开关（Claude Code）
- [x] 增加本地 settings.json Provider 选项及国际化支持
- [x] 实现 SDK 懒加载架构，增加并发控制和安全增强
- [x] 增加 Claude getMcpServerStatus API
- [x] 增加 JCEF 支持检测，改进输入处理
- [x] 优化 ai-bridge 缓存和清理机制
- [x] 改进中文输入法处理和 UI 反馈
- [x] 修复解压时 Unix 权限丢失问题
- [x] 工具按钮使用自定义 CSS 提示框替代原生 title
- [x] 将 vConsole 按钮移至左上角
- [x] 添加贡献指南（CONTRIBUTING.md）
- [x] 重构 README，突出双 AI 引擎特性描述
- [x] 提升安全性和性能优化

##### **2026年1月8日（v0.1.5-beta1）**

English:
- [x] Implement conversation rewind feature with message selection dialog and ESC shortcut support
- [x] Add JCEF availability check with user-friendly error panel
- [x] Optimize IME composition detection for better input accuracy
- [x] Add draft input state to preserve content during page navigation
- [x] Add getMcpServerStatus API for MCP server status query
- [x] Improve security: refactor PowerShell command construction to prevent injection
- [x] Improve performance: add caching and timeout safeguards for archive extraction
- [x] Preserve Unix file permissions during extraction
- [x] Add automatic cleanup of outdated ai-bridge cache on plugin version change
- [x] Fix bridge directory null check during extraction

中文:
- [x] 实现对话回退功能，支持消息选择对话框和 ESC 快捷键
- [x] 添加 JCEF 可用性检查，提供友好的错误提示面板
- [x] 优化输入法组合检测，提升输入准确性
- [x] 添加草稿输入状态，页面导航时保留内容
- [x] 添加 getMcpServerStatus API，支持查询 MCP 服务器状态
- [x] 安全改进：重构 PowerShell 命令构建以防止注入攻击
- [x] 性能改进：为压缩包解压添加缓存和超时保护
- [x] 解压时保留 Unix 文件权限
- [x] 插件版本更新时自动清理过期的 ai-bridge 缓存
- [x] 修复解压过程中桥接目录空指针检查

##### **2026年1月7日（v0.1.4）**

English:
- [x] Integrate Codex conversation functionality #codex
- [x] Implement Codex environment variable key reading
- [x] Implement Codex provider editing
- [x] Implement Codex agent support
- [x] Implement Codex usage statistics
- [x] Implement Codex enhanced prompts (actually powered by Claude)
- [x] Implement asynchronous extraction on first launch to prevent IDEA blocking
- [x] Disable slash command periodic update to resolve abnormal API request issues

中文:
- [x] 适配Codex对话功能
- [x] 实现Codex读取环境变量Key的功能
- [x] 实现Codex供应商编辑
- [x] 实现Codex智能体
- [x] 实现Codex使用统计
- [x] 实现Codex增强提示词（其实走的是Claude）
- [x] 实现首次异步解压，防止阻塞IDEA
- [x] 禁用斜杠指令定时更新功能，解决异常定时请求接口的问题

##### **2026年1月5日（v0.1.4-beta7）**

English:
- [x] P1 (fix) Fix permission dialog rejection issue in proxy mode
- [x] P1 (feat) Support official subscription-based login on macOS
- [x] P2 (fix) Resolve some error messages

中文:
- [x] P1 (fix) 修复代理模式下权限弹窗被拒绝的问题
- [x] P1 (feat) 适配Mac下官方订阅制登录的功能
- [x] P2 (fix) 解决某些报错提示

##### **2026年1月5日（v0.1.4-beta6）**

English:
- [x] P0 (bug) Fix permission dialog exception causing plugin black screen issue on Windows

中文:
- [x] P0（BUG）修复权限弹窗异常导致 Windows 下插件黑屏的问题

##### **2026年1月4日（v0.1.4-beta5）**

English:
- [x] P0 (feat) Support asking questions from CLI login state (initial) #LaCreArthur
- [x] P1 (feat) Auto-localization based on IDEA language settings
- [x] P1 (improve) Refine localization text details
- [x] P1 (feat) Add enable/disable toggle for MCP servers
- [x] P1 (feat) Add /init and /review built-in slash commands
- [x] P1 (perf) Optimize initial slash command loading logic
- [x] P1 (style) Polish UI details
- [x] P2 (feat) Support Ask User Question feature
- [x] P3 (improve) Fallback UI font to editor font #gadfly3173

中文:
- [x] P0（feat）支持从 CLI 登录状态下进行提问的功能（初版） #LaCreArthur
- [x] P1（feat）读取 IDEA 语言信息，自动本地化
- [x] P1（improve）完善本地化文案细节
- [x] P1（feat）MCP 服务器支持开启/关闭功能
- [x] P1（feat）新增 /init 和 /review 斜杠内置命令
- [x] P1（perf）优化首次加载斜杠指令逻辑
- [x] P1（style）优化部分 UI 细节
- [x] P2（feat）适配 Ask User Question 功能
- [x] P3（improve）UI 字体回落至编辑器字体 #gadfly3173

##### **2026年1月2日（v0.1.4-beta3）**

- [x] P0（feat）实现初版Agent智能体功能（提示词注入）
- [x] P1（fix）修复进入到历史记录再回来页面对话异常问题 #ｓｕ＇ｑｉａｎｇ
- [x] P2（fix）修复文件引用标签显示不存在文件夹的问题 #ｓｕ＇ｑｉａｎｇ
- [x] P2（feat）完善node版本检查 #gadfly3173

##### **2026年1月1日（v0.1.4-beta2）**

- [x] P0（feat）添加强化提示功能 #xiexiaofei
- [x] P1（feat）支持艾特多个文件的
- [x] P1（feat）优化选中文案提示词，解决AI识别不稳定的问题
- [x] P2（fix）修复删除会话后仍显示已删除会话的问题 #ｓｕ＇ｑｉａｎｇ
- [x] P2（feat）取消用户发送信息MD渲染，取消默认删除换行空格
- [x] P2（feat）增加当前字体信息展示功能
- [x] P2（feat）增加供应商设置JSON-格式化按钮
- [x] P3（fix）解决下拉列表点击不了的问题（PR#110产生的小问题）

##### **12月31日（v0.1.4-beta1）**

- [x] P1（feat）增加读取IDE字体设置
- [x] P2（feat）显示mcp服务连接状态 #gadfly3173e
- [x] P3（fix）增加用户提问问题上下折叠功能（在长度超过7行触发）
- [x] P3（UI）优化部分UI展示效果

##### **12月30日（v0.1.3）**

- [x] P1（fix）完善异常情况下的错误提醒

##### **12月26日（v0.1.2-beta7）**

- [x] P0（feat）默认增加CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC为"1"，降低遥测等问题
- [x] P1（fix）减少无法操作思考模式的问题
- [x] P1（fix）减少某些情况下一直重复编辑的问题
- [x] P3（UI）优化输入框更多功能弹窗UI触发区域

##### **12月25日（v0.1.2-beta6）**

- [x] P1（ui）将模式切换入口放到最外层
- [x] P1（feat）修复输入法组合输入渲染残留问题 #gadfly3173e
- [x] P2（BUG）修复主动思考按钮无法点击问题
- [x] P3（UX）优化三级菜单弹窗交互效果

##### **12月25日（v0.1.2-beta5）**

- [x] P0（fix）优化性能，解决输入框输入卡顿的问题（6000+对话也不卡）
- [x] P1（feat）增加主动思考配置入口
- [x] P1（fix）解决某些情况下cc-switch.db文件解析有问题
- [x] P2（fix）再次优化代码，降低window下出现无法编辑写入的BUG
- [x] P2（fix）再次优化代码，降低权限弹窗弹到其他窗口的概率
- [x] P2（fix）完善工具过程展示（之前默认全展示为成功，现在会有过程）#gadfly3173e

##### **12月25日（v0.1.2-beta4）**

- [x] P0（BUG）修复某些情况下，AI无法写入编辑的问题
- [x] P2（fix）优化提示词，解决#Lxxx-xxx 类型引入无法被AI准确理解的问题
- [x] P2（feat）实现模式切换持久化存储（不会随编辑器关闭而重置）
- [x] P3（feat）实现代码块区域复制功能

##### **12月24日（v0.1.2-beta3）**

- [x] P0（feat）实现Claude Code 模式切换功能（包括全自动权限模式）
- [x] P1（UI）优化了输入框底部按钮区域交互样式
- [x] P3（UI）优化了代码块展示样式

##### **12月23日（v0.1.2-beta2）**

- [x] P0（BUG）解决斜杠指令无法弹出的问题
- [x] P3（UI）增加90%字体的设置样式
- [x] P3（UI）优化历史对话记录样式间距过大问题（统一为对话过程中那种紧凑样式）
- [x] P3（UI）修复亮色模式下某些样式问题

##### **12月21日（v0.1.2）**

- [x] 增加字体缩放功能
- [x] 增加DIFF对比功能
- [x] 增加收藏功能
- [x] 增加修改标题功能
- [x] 增加根据标题搜索历史记录功能
- [x] 修复 alwaysThinkingEnabled 失效问题

##### **12月18日（v0.1.1-beta4）**

- [x] 解决 开启多个IDEA终端，权限弹窗 异常问题
- [x] 支持消息导出功能 #hpstream
- [x] 修复删除历史记录的某个小bug
- [x] 整体优化部分逻辑代码 #gadfly3173e

##### **12月11日（v0.1.1）**

- [x] P0（feat）实现当前打开的文件路径（将当前打开的文件信息默认发送给AI）
- [x] P0（feat）实现国际化功能
- [x] P0（feat）重构供应商管理列表，支持导入cc-switch配置
- [x] Pfeat）实现文件支持拖拽入输入框的功能（#gadfly3173 PR）
- [x] P1（feat）增加删除历史会话功能（由群友 PR）
- [x] P1（feat）增加Skills功能（由群友 PR）
- [x] P1（feat）增加右键选中代码，发送到插件的功能（#lxm1007 PR）
- [x] P1（fix）完善和重构 @文件功能，使@文件功能变得好用
- [x] P2（fix）解决输入框部分快捷操作失效的问题

##### **12月5日（v0.0.9）**

- [x] P0（feat）支持基础版本的MCP
- [x] P0（fix）解决window下，输入某些字符导致错误的问题
- [x] P0（fix）解决window下，使用node安装claude路径无法识别的问题
- [x] P0（fix）解决输入框光标无法快捷移动的问题
- [x] P0（fix）修改配置页面，之前只能展示两个字段，现在可以配置和展示多个字段
- [x] P1（feat）增加回到顶部，或者回到底部 按钮功能
- [x] P2（feat）支持文件信息点击跳转功能
- [x] P2（UI）优化权限弹窗样式
- [x] P2（fix）解决DIFF组件统计不精准的问题
- [x] P3（fix）打开历史会话自动定位到最底部
- [x] P3（fix）优化文件夹可点击效果
- [x] P3（fix）优化输入框工具切换icon
- [x] P3（fix）取消MD区域文件可点击功能
- [x] P3（UI）解决渠道删除按钮背景颜色问题
- [x] P3（fix）将点击供应商链接调跳转改为复制链接，以防止出现问题

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/4.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/5.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/6.png" />

##### **12月2日（v0.0.8）**

- [x] P0（feat）增加主动调整Node路径的功能，用以适配五花八门的Node路径
- [x] P1（feat）增加白色主题
- [x] P1（feat）将渠道配置功能与cc-switch解耦，防止规则改变导致渠道丢失
- [x] P1（feat）增加各种错误情况下的提示功能，减少空白展示情况
- [x] P1（feat）优化@文件功能（回车发送问题还未解决）
- [x] P2（fix）解决 运行命令 右侧小圆点总是展示置灰的问题
- [x] P2（fix）解决对话超时后，新建对话，原来的对话还在执行，点停止按钮也没反应
- [x] P2（UX）优化多处其他UI以及交互细节
- [x] P3（chore）插件兼容23.2版本IDEA版本

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/2.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/3.png" />

---

##### **12月1日（v0.0.7-beta2）**

- [x] P0: 重构代码 channel-manager.js 和 ClaudeSDKBridge.java 主代码
- [x] P1: 解决某些三方API兼容性问题

##### **11月30日（v0.0.7）**

- [x] P0: 支持选择 Opus4.5 进行提问
- [x] P0: 将权限弹窗由系统弹窗改为页面内弹窗，并且增加了允许且不再询问的功能
- [x] P1: 重构展示区域UI效果
- [x] P3: 优化顶部按钮展示问题
- [x] P3: 优化Loding样式
- [x] P5: 优化样式细节

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.7/2.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.7/1.png" />


##### **11月27日（v0.0.6）**

- [x] 重构 输入框UI交互
- [x] 输入框 支持发送图片
- [x] 输入框 支持模型容量统计
- [x] 优化 数据统计页面 UI样式
- [x] 优化 设置页面侧边栏展示样式
- [x] 重构 多平台兼容性问题
- [x] 解决某些特殊情况下响应无法中断的BUG

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/3.png" />


##### **11月26日（v0.0.5）**

- [x] 增加使用统计
- [x] 解决Window下新建问题按钮失效问题
- [x] 优化一些细节样式

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/2.png" />


##### **11月24日（v0.0.4）**

- [x] 实现简易版本cc-switch功能
- [x] 解决一些小的交互问题

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.4/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.4/2.png" />


##### **11月23日（v0.0.3）**

- [x] 解决一些核心交互阻塞流程
- [x] 重构交互页面UI展示

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.3/1.png" />


##### **11月22日**

- [x] 改进临时目录与权限逻辑
- [x] 拆分纯html，采用 Vite + React + TS 开发
- [x] 将前端资源CDN下载本地打包，加快首屏速度


##### **11月21日（v0.0.2）**

完成简易的，GUI对话 权限控制功能

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/5.png" />

文件写入功能展示

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/6.png" />


##### 11月20日

完成简易的，GUI对话基础页面

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/2.png" />

完成简易的，GUI对话页面，历史消息渲染功能

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/3.png" />

完成简易的，GUI页面，对话 + 回复 功能（**完成 claude-bridge 核心**）

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/4.png" />

##### 11月19日（v0.0.1） - 实现历史记录读取功能

<img width="400" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/1.png" />

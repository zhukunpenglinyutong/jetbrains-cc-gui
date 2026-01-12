##### **2026年1月12日（v0.1.5-beta4）**

English:
- [x] Add experimental PyCharm support (Install from Disk)
- [x] Implement Python semantic context collection (requires Python plugin)
- [x] Optimize cross-IDE compatibility for ContextCollector

中文:
- [x] 新增 PyCharm 实验性支持（支持本地安装）
- [x] 实现 Python 语义上下文采集（依赖 Python 插件）
- [x] 优化 ContextCollector 跨 IDE 兼容性

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

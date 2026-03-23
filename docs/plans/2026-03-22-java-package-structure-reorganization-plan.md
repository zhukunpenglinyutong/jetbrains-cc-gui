# Java 主包目录结构整理计划

**日期**: 2026-03-22  
**状态**: 待执行  
**范围**: `src/main/java/com/github/claudecodegui`  
**目标**: 在不改变插件行为、消息协议和用户体验的前提下，逐步收敛根包、按功能分组目录、降低后续维护和继续重构的理解成本。

---

## 背景判断

当前结构并不是“完全错误”，但已经出现了典型的“分层做到一半”的迹象。

基于现有代码结构的快速盘点：

- 根包 `com.github.claudecodegui` 下面仍直接放了约 20 个类，职责混合了窗口、会话、设置、技能、Action 和工具拦截。
- `handler` 目录已有约 47 个类，是目前最容易继续膨胀的目录。
- `util` 目录已有约 18 个类，里面既有纯工具类，也有带明显业务语义的配置类。
- 与此同时，`permission`、`session`、`provider`、`skill`、`settings`、`ui` 等功能目录已经初步存在，说明项目已经朝“按功能分组”的方向发展。

因此，这次整理的核心目标不是推倒重来，而是把已经形成的分组方向收口，让目录结构更一致、更容易理解。

---

## 核心原则

### 1. 按功能分组，不按类名后缀分组

不建议把所有 `Service`、`Manager`、`Handler`、`Action` 简单集中到同一目录。

原因：

- 这种分法表面整齐，但会把同一业务链路拆散。
- 后续定位问题时，往往是按“会话 / 权限 / Provider / 技能 / UI”来思考，而不是按“这是个 Service 还是 Manager”来思考。
- 当前仓库已经有大量按功能分组的基础目录，继续沿这个方向最稳。

### 2. 先清理根包，再继续细分大目录

优先级建议：

1. 先把根包里的明显归属类迁回功能目录。
2. 再细分 `handler`。
3. 最后收敛 `util`，只保留真正的通用工具类。

### 3. 小步重构，不一次性搬完整棵树

本计划强调分阶段、小批量迁移：

- 每一轮只处理一组低耦合对象。
- 每次迁移后都进行编译和插件注册校验。
- 不在目录迁移时顺便改业务逻辑，避免把“结构整理”和“功能变更”叠到一起。

### 4. 目录移动必须同步更新注册与引用

这是 IntelliJ 插件项目，类路径不仅存在于 Java import 中，也存在于注册文件中。

尤其要同步检查：

- `src/main/resources/META-INF/plugin.xml`
- 任何通过反射、字符串类名、静态入口引用到旧包路径的代码

---

## 推荐目标目录树

```text
src/main/java/com/github/claudecodegui
├── action
│   ├── chat          // 聊天窗口内动作：发送、复制、粘贴、换行、快捷键同步
│   ├── dev           // 开发辅助动作：DevTools 等
│   ├── editor        // 编辑器/项目树动作：发送选中代码、发送文件路径、Quick Fix
│   ├── tab           // 标签页动作：新建、重命名、分离
│   └── vcs           // Git / Commit 相关动作
├── bridge            // Node / SDK bridge 环境、目录、进程管理
├── cache             // Session 索引与缓存
├── dependency        // 依赖安装、更新检测、结果对象
├── handler
│   ├── core          // Dispatcher、Base handler、上下文对象
│   ├── context       // Java / Python / Runtime 上下文采集
│   ├── diff          // Diff 展示、刷新、请求分发
│   ├── file          // 文件打开、导出、撤销、收集器
│   ├── history       // 历史记录加载、删除、导出、元数据、注入
│   ├── provider      // Provider 读取、切换、导入导出、排序
│   ├── session       // Session 消息处理
│   ├── settings      // 设置相关 handler
│   ├── skill         // Skill / Agent / MCP 相关 handler
│   └── window        // Tab / Window 事件处理
├── i18n              // 国际化 bundle 入口
├── model             // 纯数据模型、枚举、结果对象
├── notifications     // 通知、状态栏、提示音
├── permission        // 权限请求、Diff review、tool interception
├── provider
│   ├── claude
│   ├── codex
│   └── common
├── session           // 会话状态、回调、消息编排、生命周期
├── settings          // 配置 facade 与各类 manager
├── skill             // Claude / Codex skill 扫描、解析、注册
├── startup           // 启动预热、插件更新监听
├── terminal          // Terminal 集成
├── ui
│   ├── detached      // 分离窗口
│   ├── toolwindow    // ToolWindow / ChatWindow / tab 关联管理
│   └── webview       // Webview 初始化、watchdog、delegate、编辑器上下文桥接
├── util              // 仅保留通用、无状态工具类
└── watcher           // 文件监听器（若数量持续增长，可再拆）
```

---

## 根包迁移建议对照表

以下类建议优先从根包迁移到对应目录。

| 当前类 | 建议新位置 | 说明 |
| --- | --- | --- |
| `ClaudeChatWindow` | `ui/toolwindow/ClaudeChatWindow.java` | 聊天窗口核心对象，明显属于 ToolWindow/UI 侧 |
| `ClaudeSDKToolWindow` | `ui/toolwindow/ClaudeSDKToolWindow.java` | ToolWindow 工厂与入口 |
| `CodeSnippetManager` | `ui/toolwindow/CodeSnippetManager.java` | 标签页/窗口间片段投递协调 |
| `DetachedChatFrame` | `ui/detached/DetachedChatFrame.java` | 分离窗口 UI |
| `DetachedWindowManager` | `ui/detached/DetachedWindowManager.java` | 分离窗口注册与生命周期 |
| `ClaudeSession` | `session/ClaudeSession.java` | 会话核心对象，应与现有 `session` 包收拢 |
| `SessionLoadService` | `session/SessionLoadService.java` | 会话加载桥接服务 |
| `CodemossSettingsService` | `settings/CodemossSettingsService.java` | 配置 facade，和现有 `settings` 包高度一致 |
| `SkillService` | `skill/SkillService.java` | Claude 技能管理 |
| `CodexSkillService` | `skill/CodexSkillService.java` | Codex 技能管理 |
| `ToolInterceptor` | `permission/ToolInterceptor.java` | 权限相关工具调用拦截 |
| `ClaudeCodeGuiBundle` | `i18n/ClaudeCodeGuiBundle.java` | 国际化入口类，避免长期占据根包 |
| `CreateNewTabAction` | `action/tab/CreateNewTabAction.java` | 标签页动作 |
| `RenameTabAction` | `action/tab/RenameTabAction.java` | 标签页动作 |
| `DetachTabAction` | `action/tab/DetachTabAction.java` | 标签页动作 |
| `SendSelectionToTerminalAction` | `action/editor/SendSelectionToTerminalAction.java` | 编辑器右键动作 |
| `SendFilePathToInputAction` | `action/editor/SendFilePathToInputAction.java` | 项目树右键动作 |
| `QuickFixWithClaudeAction` | `action/editor/QuickFixWithClaudeAction.java` | 编辑器修复动作 |
| `GenerateCommitMessageAction` | `action/vcs/GenerateCommitMessageAction.java` | VCS / Commit 动作 |
| `OpenDevToolsAction` | `action/dev/OpenDevToolsAction.java` | 开发调试动作 |

完成这一轮后，根包应尽量只保留极少数真正无法明确归属的顶层入口类。理想状态下，根包最终可以接近空壳。

---

## `action` 目录整理建议

当前项目已经有 `action` 包，但只覆盖了聊天窗口内部动作，属于“已经开了头但没有统一到底”的状态。

建议最终分为以下几组：

### `action/chat`

- `ChatSendAction`
- `ChatNewlineAction`
- `ChatCopyAction`
- `ChatCutAction`
- `ChatPasteAction`
- `ChatToolWindowAction`
- `SendShortcutSync`

### `action/editor`

- `SendSelectionToTerminalAction`
- `SendFilePathToInputAction`
- `QuickFixWithClaudeAction`

### `action/tab`

- `CreateNewTabAction`
- `RenameTabAction`
- `DetachTabAction`

### `action/vcs`

- `GenerateCommitMessageAction`

### `action/dev`

- `OpenDevToolsAction`

---

## `handler` 目录二次拆分建议

`handler` 是当前最需要继续细分的目录，但不建议一上来大改逻辑。最稳的方式是保留消息协议和入口类行为，只按职责移动文件。

### `handler/core`

建议归入：

- `BaseMessageHandler`
- `MessageHandler`
- `MessageDispatcher`
- `HandlerContext`

### `handler/file`

建议归入：

- `FileHandler`
- `OpenFileHandler`
- `FileExportHandler`
- `UndoFileHandler`
- `OpenFileCollector`
- `RecentFileCollector`
- `FileSystemCollector`
- `RuntimeContextCollector`

### `handler/history`

建议归入：

- `HistoryHandler`
- `HistoryLoadService`
- `HistoryDeleteService`
- `HistoryExportService`
- `HistoryMetadataService`
- `HistoryMessageInjector`

### `handler/provider`

建议归入：

- `ProviderHandler`
- `ClaudeProviderOperations`
- `CodexProviderOperations`
- `ProviderImportExportSupport`
- `ProviderOrderingService`
- `ModelProviderHandler`

### `handler/session`

建议归入：

- `SessionHandler`

### `handler/settings`

建议归入：

- `SettingsHandler`
- `NodePathHandler`
- `PermissionModeHandler`
- `SoundSettingsHandler`
- `InputHistoryHandler`
- `ProjectConfigHandler`

### `handler/skill`

建议归入：

- `SkillHandler`
- `AgentHandler`
- `McpServerHandler`
- `CodexMcpServerHandler`
- `DependencyHandler`

### `handler/window`

建议归入：

- `TabHandler`
- `WindowEventHandler`

### 保持原样的子目录

以下目录已经较清晰，可在第一阶段保持不动：

- `handler/context`
- `handler/diff`

---

## `util` 目录收敛原则

`util` 不建议继续作为“任何暂时不知道放哪就先塞进去”的目录。

推荐原则：

- **保留在 `util` 的类**：纯函数、无状态、跨多个功能域复用的工具类。
- **逐步迁出的类**：名称中带有明显业务语义、配置语义、主题语义、声音语义、语言语义的类。

可保留在 `util` 的典型类：

- `PathUtils`
- `LineSeparatorUtil`
- `TagExtractor`
- `IgnoreRuleParser`
- `IgnoreRuleMatcher`
- `TokenUsageUtils`

可作为后续候选迁出的类：

- `ThemeConfigService`
- `FontConfigService`
- `LanguageConfigService`
- `SoundNotificationService`
- `HtmlLoader`
- `JBCefBrowserFactory`

这一步不需要优先执行，但应作为结构治理的长期约束，避免 `util` 持续膨胀。

---

## 推荐执行顺序

### Phase 1：清理根包

目标：

- 先处理最容易确认归属的类。
- 最大化“第一眼可读性”提升。
- 降低后续继续细分时的认知负担。

建议顺序：

1. 迁移根包 Action 到 `action/*`
2. 迁移 `ClaudeSession`、`SessionLoadService` 到 `session`
3. 迁移 `CodemossSettingsService` 到 `settings`
4. 迁移 `SkillService`、`CodexSkillService` 到 `skill`
5. 迁移 `ClaudeChatWindow`、`ClaudeSDKToolWindow`、`CodeSnippetManager` 到 `ui/toolwindow`
6. 迁移 `DetachedChatFrame`、`DetachedWindowManager` 到 `ui/detached`
7. 迁移 `ToolInterceptor` 到 `permission`
8. 迁移 `ClaudeCodeGuiBundle` 到 `i18n`

### Phase 2：细分 `handler`

目标：

- 保持现有 `SUPPORTED_TYPES` 和消息分发协议不变。
- 按功能继续收拢文件位置。

建议顺序：

1. `core`
2. `history`
3. `file`
4. `provider`
5. `settings`
6. `skill`
7. `window`
8. `session`

### Phase 3：收敛 `util`

目标：

- 把 `util` 恢复为“真正的工具类目录”。
- 将业务意味较强的对象迁回所属功能域。

### Phase 4：文档与命名复查

目标：

- 确保目录结构调整后仍易于新人理解。
- 避免“搬过去了，但命名还是旧上下文”的情况。

建议检查：

- 类名是否还反映当前职责
- 包名与类职责是否一致
- 文档、注释、注册文件是否同步更新

---

## 实施约束

为避免结构整理演变为高风险功能改造，本计划约束如下：

- 不在目录迁移时顺便改业务逻辑。
- 不在同一轮里同时改消息协议、UI 交互和包结构。
- 不一次性批量移动过多核心类，优先做低耦合迁移。
- 每次迁移后立即修正 import、注册类名和相关引用。
- 若发现某个类与多个目录强耦合，先暂停迁移，只记录为待决策项。

---

## 风险点

### 1. `plugin.xml` 注册路径失效

受影响对象：

- ToolWindow factory
- Action 注册
- 任何扩展点实现类

处理方式：

- 每一轮目录迁移后立即检查 `src/main/resources/META-INF/plugin.xml`
- 保证类路径与包名同步更新

### 2. 包级可见性与静态协作关系

例如窗口相关类之间存在包级方法调用或强协作关系，迁移时可能暴露出隐藏耦合。

处理方式：

- 先搬协作最紧密的一组类，避免拆散半套协作对象
- 必要时再决定是否提升可见性或引入更明确的 coordinator

### 3. 大目录移动引发大面积 import 修改

处理方式：

- 每次只移动一组相关类
- 每次移动后立即编译验证，避免把多个错误点叠到一起

### 4. `handler` 拆分时误伤消息协议

处理方式：

- 保留原入口类与消息类型定义
- 只做物理位置整理与内部委托调整，不改前端协议

---

## 验收标准

完成本计划时，应满足以下标准：

- 根包显著瘦身，不再混放窗口、Action、设置、技能、会话等多类职责。
- 目录结构能从名字直接反映功能域，而不是只能靠类名猜职责。
- `plugin.xml` 与所有 Java 引用同步更新，无失效注册。
- `handler` 不再是单层超大目录，核心子领域可以独立浏览。
- `util` 不再继续吸纳带业务语义的服务对象。
- 插件行为、消息协议、用户操作路径保持不变。

---

## 推荐验证方式

每一轮目录迁移后，至少执行以下验证：

### 编译 / 测试

- `./gradlew test`

### 定向人工检查

- ToolWindow 能否正常打开
- 新建标签页 / 重命名 / 分离窗口是否正常
- 编辑器右键发送代码、发送文件路径是否正常
- Quick Fix Action 是否仍可触发
- Commit Message Action 是否仍可显示

### 注册文件检查

- `src/main/resources/META-INF/plugin.xml` 中所有迁移类路径都已同步修改

---

## 非目标

本计划暂不包含以下内容：

- 重写现有业务逻辑
- 改造 `provider/claude`、`provider/codex` 的内部设计
- 大规模重命名消息类型或前后端协议
- 一次性清空所有历史结构问题

这是一份“结构整理计划”，不是“一步到位的架构重写计划”。

---

## 总结

当前项目更适合继续沿“按功能分组”的方向演进，而不是退回到“按 Service / Manager / Handler 类型分组”的做法。

最优先、最划算的一步，是先把根包清理干净；第二步再继续把 `handler` 拆成多个子目录；最后再逐步收敛 `util`。

如果后续按本计划执行，项目目录会更接近“新同事第一次打开就能快速知道每块代码在哪”的状态，同时还能把重构风险控制在较低水平。

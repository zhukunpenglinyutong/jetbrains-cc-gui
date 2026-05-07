# CC GUI Webview 重构执行计划

> **基于 Vercel React Best Practices（2026）官方规则的全面诊断**
> 分析时间：2026-05-06 | 分析方法：5 Agent 并行排查 + Vercel 70 条规则对照
> 目标：把 webview 从"可运行但难维护"提升到"清晰、高性能、类型安全"

---

## 一、项目现状速览

| 维度 | 评分 | 关键数据 |
|------|------|---------|
| 架构质量 | 3/10 | App.tsx 741 行 + 55 个 hooks 集中 |
| 性能 | 4/10 | 26 个 useState 集中在 App、177 处内联函数/样式 |
| TS 严格度 | 2/10 | 105 处 `as any` + 52 处 `[key: string]: any` |
| 可维护性 | 2/10 | 9 个组件 >600 行、props drilling 45+ |
| 代码分割 | 1/10 | vite-plugin-singlefile 强制单文件、无 lazy |
| 错误处理 | 3/10 | 仅 2 个 Error Boundary |

---

## 二、收益 / 成本四象限矩阵

```
              收益 高
                ↑
                │
    [立即做 P0] │ [重点规划 P1]
                │
   低成本 ──────┼────── 高成本
                │
    [顺便做 P2] │ [暂不做 P3]
                │
                ↓
              收益 低
```

| 象限 | 任务数 | 累计预估 | 性质 |
|------|-------|---------|------|
| **P0 立即做**（高收益低成本） | 6 | 2-3 天 | 一次性受益、改动局部 |
| **P1 重点规划**（高收益高成本） | 6 | 3-4 周 | 需要分阶段、影响面大 |
| **P2 顺便做**（低收益低成本） | 4 | 1-2 天 | 配合其他任务一起做 |
| **P3 暂不做**（低收益高成本） | 3 | - | 投入产出比低，先观察 |

---

## 三、P0 立即执行任务（高收益 / 低成本）

### TASK-P0-01：清理生产代码中的 console.log ✅ 已完成（2026-05-06）

- **优先级**：P0
- **预计耗时**：1 小时
- **实际耗时**：~30 分钟
- **收益**：⭐⭐⭐ （减少生产噪声，避免性能损耗）
- **风险**：🟢 低（删除日志，无逻辑变更）
- **依赖**：无

#### 涉及文件（已处理）
- `webview/src/main.tsx`（37 处 → 0 处源代码调用）
- `webview/src/hooks/useFileChangesManagement.ts`（1 处 → 0 处）
- `webview/src/components/UsageStatistics/useUsageStatistics.ts`（1 处 → 0 处）

#### 执行步骤
- [x] 全局搜索 `console.log`，逐一审查
- [x] 复用现有 `webview/src/utils/debug.ts` 中的 `debugLog` 工具（项目约定：不引入新工具）
  - `debugLog(...args)`：仅在 `import.meta.env.DEV` 为 true 时打印
  - 同模块还提供 `debugWarn` / `debugError`
- [x] 替换所有源代码中的 `console.log(...)` 为 `debugLog(...)`
  - 保留 main.tsx 第 19-23 行的 `console.log = noop` 生产环境静默器赋值
  - 保留 `version/changelog.ts` 中字符串内容（非实际调用）
  - 保留 `utils/debug.ts` 内部的 console.log（已被 DEV 检查门控）
- [x] `cd webview && npm run build` 验证构建通过

#### 验收结果
- ✅ 源代码中已无 `console.log(...)` 调用（只剩生产静默器赋值）
- ✅ 仅保留 `console.warn` / `console.error` / `debugLog`
- ✅ 构建通过：`vite build` 成功生成 dist/index.html
- ⚠️ dist 中残留的 27 处 `console.log(` 来自第三方库（mermaid、dompurify、chevrotain、highlight.js 等）和 `debugLog` 函数体的死分支（`ck && console.log(...)`，运行时 `ck === false`）。已通过 `main.tsx` 的运行时覆盖（`console.log = noop`）+ DEV 短路实现双重保险

---

### TASK-P0-02：列表项组件 React.memo 化 ✅ 已完成（2026-05-06）

- **优先级**：P0
- **预计耗时**：4-6 小时
- **实际耗时**：~1.5 小时
- **收益**：⭐⭐⭐⭐⭐ （直接提升列表渲染性能 50%+）
- **风险**：🟢 低（提取子组件 + memo，纯优化）
- **依赖**：无

> 对应 Vercel 规则：5.4 Don't Define Components Inside Components + rerender-memo

#### 涉及文件（已处理）
| 文件 | 处理结果 |
|------|---------|
| `webview/src/components/StatusPanel/SubagentList.tsx` | 提取 `SubagentRow` memo 子组件，父组件 `handleToggleRow` 用 `useCallback` 稳定 |
| `webview/src/components/StatusPanel/FileChangesList.tsx` | 提取 `FileChangeRow` memo 子组件，所有点击回调改为 row 内部 `useCallback` |
| `webview/src/components/history/HistoryView.tsx` | 提取 `HistoryItem` memo 子组件 + 14 个父组件回调改为 `useCallback`；提取 8 个内联 style 为模块级常量；将 `highlightText` / `stopPropagationHandler` 提升到模块级 |
| `webview/src/components/MessageList.tsx` | 已 memo 化，`MessageItem` 已是独立 memo 组件（无需变更） |

#### 执行结果
- [x] **Step 1**：所有 `.map()` 内联 JSX 已提取为模块级 memo 组件（`SubagentRow` / `FileChangeRow` / `HistoryItem`）
- [x] **Step 2**：父组件中所有传给 row 的回调用 `useCallback` 稳定（含 `handleEditStart` / `handleEditSave` / `handleCopySessionId` 等 14 个）
- [x] **Step 3**：HistoryView 中 8 个内联样式（`PROVIDER_BADGE_STYLE`、`HIGHLIGHT_MARK_STYLE`、`ROOT_STYLE` 等）提取到模块顶部
- [x] **Step 4**：构建通过 + 全部 356 个 webview 测试通过

#### 验收结果
- ✅ 单元测试：`npm test -- --run` → 356 / 356 通过
- ✅ 构建：`npm run build` → vite build 成功（5.7MB / 1.6MB gzip）
- ✅ 无 `key={index}` 反模式
- ✅ 列表项组件接收的 props 全部稳定引用（基本类型 + 经 `useCallback` 稳定的回调），React.memo 浅比较即可命中
- ⚠️ 待补充：React DevTools Profiler 在浏览器中实际验证「未变化行 Did not render」的工作有赖于运行 IDE 实例（不在本次 PR 范围）

---

### TASK-P0-03：消除 (window as any).xxx 全局回调污染 ✅ 已完成（2026-05-07）

- **优先级**：P0
- **预计耗时**：3-4 小时
- **实际耗时**：~30 分钟
- **收益**：⭐⭐⭐⭐ （类型安全 + 内存泄漏修复）
- **风险**：🟡 中（涉及跨窗口通信，需小心测试）
- **依赖**：无

> 对应代码质量问题：起始 110+ 处 `(window as any).xxx`（生产代码 11 处 + 测试代码 99 处）

#### 实际处理结果

| 类别 | 起始 | 处理后 |
|------|-----|--------|
| 生产代码 (`src/**/*.ts(x)` 非测试) | 11 处 | **0 处** |
| 测试代码 (`*.test.ts`) | 99 处 | **0 处** |
| **合计** | **110+ 处** | **0 处** |

#### 涉及文件（已处理）

**类型补全（global.d.ts）** — 在文件末尾新增 4 个 Window 属性类型：
- `__INITIAL_IDE_THEME__?: 'light' | 'dark'`（Java 注入的初始主题）
- `updateCliLoginAccountInfo?: (email: string) => void`（CLI 登录账号回调）
- `import_preview_result?: (dataOrStr: string \| { providers?: unknown }) => void`（Provider 导入预览回调）
- `backend_notification?: (...args: unknown[]) => void`（后端通知变参回调）

**生产代码替换（5 个文件）**：
| 文件 | 处理 |
|------|------|
| `webview/src/main.tsx:500` | `(window as any).__pendingSessionId` → `window.__pendingSessionId`（类型已存在）|
| `webview/src/hooks/useThemeInit.ts:10, 75` | `(window as any).__INITIAL_IDE_THEME__` → `window.__INITIAL_IDE_THEME__` |
| `webview/src/utils/messageUtils.ts:756/758/759/769` | 4 处 `(window as any).__lastStreamEnded*` → `window.__lastStreamEnded*` |
| `webview/src/hooks/useSessionManagement.ts:98-99` | `(window as any).__resetTransientUiState` → `window.__resetTransientUiState` |
| `webview/src/components/settings/ProviderList/index.tsx:75/82/95/150-152` | 6 处涉及注册 + cleanup（`updateCliLoginAccountInfo` / `import_preview_result` / `backend_notification`）。注册路径走 useEffect，清理路径走 `delete window.xxx` |

**测试代码批量替换（3 个文件，99 处）**：
- `webview/src/hooks/useWindowCallbacks.test.ts`（50 处）
- `webview/src/hooks/useSessionManagement.test.ts`（47 处）
- `webview/src/components/settings/hooks/useSettingsWindowCallbacks.test.ts`（2 处）
- 替换方式：`sed -i '' 's/(window as any)\./window./g'`，依赖 global.d.ts 中已声明的可选属性
- 测试被 `tsconfig.json` 排除，由 vitest + esbuild 直接运行，runtime 行为不变

#### 执行步骤
- [x] **Step 1**：在 `webview/src/global.d.ts` 中补全 4 个缺失的 Window 扩展属性类型
- [x] **Step 2**：将所有生产代码中的 `(window as any).xxx` 改为 `window.xxx`
- [x] **Step 3**：ProviderList useEffect 清理函数已存在 `delete window.xxx` 模式（无需新增）
- [x] **Step 4**：测试代码批量替换 + 全部 356 个单测通过验证通信路径

#### 验收结果
- ✅ `grep -rn "(window as any)" webview/src` → **0 处**
- ✅ TypeScript：`npx tsc --noEmit` 无源代码错误（仅 tsconfig 中 `erasableSyntaxOnly` 选项警告，与本任务无关）
- ✅ 单元测试：`npm test -- --run` → **356 / 356 通过**
- ✅ 构建：`npm run build` → vite build 成功（5.7MB / 1.6MB gzip）
- ✅ 设置面板的 CLI 登录回调、provider 通知、import preview 等功能保持现有 useEffect 注册 + cleanup 模式
- ⚠️ Java → Webview 实际通信路径需在 IDE 实例中验证，留待运行时验证

---

### TASK-P0-04：修复事件监听器内存泄漏 ✅ 已完成（2026-05-06）

- **优先级**：P0
- **预计耗时**：2 小时
- **实际耗时**：~30 分钟
- **收益**：⭐⭐⭐ （内存稳定性）
- **风险**：🟢 低
- **依赖**：无

#### 全量审计结果

对 `webview/src` 全部 76 处 `addEventListener` 与 71 处 `removeEventListener` 进行交叉对比，绝大多数已有正确清理。仅识别出 **2 处真实问题**：

| 文件 | 位置 | 问题 | 修复方案 |
|------|------|------|---------|
| `components/ChatInputBox/providers/fileReferenceProvider.ts` | L157 | `signal.addEventListener('abort', ...)` 未加 `{ once: true }`；同一长生命周期 signal 多次调用会累积监听器 | 添加 `{ once: true }`，与 agentProvider / slashCommandProvider / promptProvider 模式保持一致 |
| `main.tsx`（`setupScaleRecovery`） | L203 / 217 / 222 | 使用匿名箭头函数注册 `visibilitychange` / `focus` / `pageshow`，技术上无法被 `removeEventListener` 卸下；虽属页面级一次性 setup，但与文件内 heartbeat 的 `pagehide` cleanup 模式不一致 | 提取为命名 handler `onVisibilityChange` / `onWindowFocus` / `onPageShow`；新增 `cleanup()` 在 `beforeunload` / `pagehide` / Vite HMR dispose 时统一移除，与 `createBridgeHeartbeatStarter` 的清理模式对齐 |

#### 已确认正确的高频清理模式（无需变更）

- `useDragSort.ts:180/192/199`：使用 `AbortController.signal` 选项注册，abort 时浏览器自动卸载 ✅
- `slashCommandProvider.ts:170` / `agentProvider.ts:125` / `promptProvider.ts:173`：均使用 `{ once: true }` ✅
- `App.tsx:201-203`（dragover/drop/dragenter）：useEffect 内成对 add/remove ✅
- `settings/ProviderList/index.tsx:136-138`：useEffect cleanup 完整移除三个监听器 + 清空 window 全局回调 ✅
- 其余所有对话框/下拉菜单/click-outside / keydown 监听均位于 useEffect 中且 cleanup 函数对应 `removeEventListener` ✅

#### 涉及文件（已处理）

- `webview/src/components/ChatInputBox/providers/fileReferenceProvider.ts`（L157 添加 `{ once: true }` 选项）
- `webview/src/main.tsx`（`setupScaleRecovery` 函数：3 处匿名监听器改为命名 handler + 新增 `cleanup` 在 beforeunload/pagehide/HMR dispose 时移除）

#### 验收结果

- ✅ `grep -rn "addEventListener" webview/src` 全部 76 处 与 `removeEventListener` 完整交叉匹配
- ✅ `cd webview && npm test -- --run` → **356 / 356 通过**
- ✅ `cd webview && npm run build` → vite build 成功（5.7MB / 1.6MB gzip）
- ✅ 所有 `addEventListener` 现在均有清理路径：useEffect cleanup / `{ once: true }` / `AbortController.signal` / `pagehide` 命名 handler 移除
- ⚠️ Chrome DevTools Memory Profile 实测验证需在 IDE 实例中进行，留待运行时验证

---

### TASK-P0-05：内联样式提取为模块常量 ✅ 已完成（2026-05-06）

- **优先级**：P0
- **预计耗时**：4-5 小时
- **实际耗时**：~2 小时
- **收益**：⭐⭐⭐⭐ （配合 memo 化才有效，否则破坏 memoization）
- **风险**：🟢 低
- **依赖**：可与 TASK-P0-02 一起做

> 对应 Vercel 规则：5.5 Extract Default Non-primitive Parameter Values

#### 涉及文件（已处理，共 51 个文件）

起始数量：**258 处** `style={{...}}`（比计划中 177 处更多）  
最终数量：**1 处**（仅 `AnimatedText/index.tsx:66` 的 `transitionDelay: \`${delay}ms\`` 动态值保留）

分批处理：
- **第一批（8 个高频文件）**：ConfigSelect.tsx(25→0), EditToolGroupBlock.tsx(22→0), EditToolBlock.tsx(22→0), ErrorBoundary.tsx(18→0), SearchToolGroupBlock.tsx(11→0), ReadToolGroupBlock.tsx(10→0), ReadToolBlock.tsx(9→0), GenericToolBlock.tsx(6→0)
- **第二批（43 个中低频文件）**：settings/index.tsx(13→0), 以及其余所有文件全部清零

#### 重构模式应用
- **纯静态样式** → 模块顶部 `const NAME_STYLE: React.CSSProperties = {...}` 常量
- **条件切换**（如 `display: x ? 'block' : 'none'`）→ 两个命名常量 + JSX 处三目运算 `style={cond ? BLOCK_STYLE : NONE_STYLE}`
- **函数派生样式**（如 `color: getIconColor()`）→ JSX 前计算 `const iconStyle = {...}`
- **map 内的 item 样式** → 模块级辅助函数 `function getXStyle(param): React.CSSProperties {...}`
- **真正动态样式**（如 `transitionDelay: \`${delay}ms\``）→ 保留为 `style={{...}}`

#### 执行步骤
- [x] **Step 1**：列出所有内联样式，分为三类（常量/条件/动态）
- [x] **Step 2**：按文件批量重构
- [x] **Step 3**：验证构建和测试通过

#### 验收结果
- ✅ `grep -c "style={{" webview/src --include="*.tsx" -r` → **1 处**（远低于 50 的目标）
- ✅ 单元测试：`npm test -- --run` → 356 / 356 通过
- ✅ 构建：`npm run build` → vite build 成功
- ✅ TypeScript：`tsc --noEmit` 无错误
- ✅ 无 useMemo 引入（简单场景不需要）
- ✅ 无 className、逻辑、import 变更

---

### TASK-P0-06：启用 TypeScript 严格模式（基线）

- **优先级**：P0
- **预计耗时**：2 小时（仅启用 + 修复关键报错）
- **收益**：⭐⭐⭐⭐ （阻止后续 any 蔓延）
- **风险**：🟡 中（可能暴露大量已有问题）
- **依赖**：无

#### 涉及文件
- `webview/tsconfig.json`

#### 执行步骤
- [ ] **Step 1**：阅读当前 tsconfig.json，记录现有配置
- [ ] **Step 2**：渐进开启严格选项（一次开一个，修复后再开下一个）：
  ```json
  {
    "compilerOptions": {
      "strict": false,                    // 总开关，先不开
      "noImplicitAny": true,              // 第一步：先开这个
      "strictNullChecks": true,           // 第二步
      "strictFunctionTypes": true,        // 第三步
      "noUnusedLocals": true,             // 顺便开
      "noUnusedParameters": true,
      "noFallthroughCasesInSwitch": true
    }
  }
  ```
- [ ] **Step 3**：每开一个，运行 `npx tsc --noEmit` 看报错数量
- [ ] **Step 4**：本任务只确保**不报错**（用 `// @ts-expect-error TODO P2-XX` 临时压制），完整修复留给 P2

#### 验收标准
- `npx tsc --noEmit` 通过
- 新增的 `// @ts-expect-error` 都有对应的 P2 任务追踪

---

## 四、P1 重点规划任务（高收益 / 高成本）

### TASK-P1-01：拆解 App.tsx God Component

- **优先级**：P1
- **预计耗时**：3-5 天
- **收益**：⭐⭐⭐⭐⭐ （根本性改善可维护性 + 性能）
- **风险**：🔴 高（改动核心，需充分测试）
- **依赖**：建议先完成 P0-02、P0-05

> 对应 Vercel 规则：5.9 Split Combined Hook Computations + 单一职责

#### 现状
```
App.tsx (741 行)
├── 26 个 useState
├── 12 个 useCallback
├── 9 个 useRef
├── 7 个 useMemo
└── 7 个 useEffect
```

#### 目标架构
```
App.tsx (< 200 行，仅 Provider 组合)
├── <MessagesProvider>      消息流状态
│   ├── messages, subagentHistories, streamingActive
├── <SessionProvider>       会话状态
│   ├── currentSessionId, customSessionTitle, sessionHistory
├── <SettingsProvider>      设置状态
│   ├── theme, locale, modelProvider 相关
└── <DialogProvider>        UI 状态
    ├── 各类弹窗 open/close
```

#### 执行步骤（分阶段，每阶段一个 PR）

**阶段 1：MessagesProvider（1-2 天）**
- [ ] 新建 `webview/src/contexts/MessagesContext.tsx`
- [ ] 提取所有 messages / streaming 相关 state
- [ ] 提供 getter 函数模式（参考 SubagentContext.tsx）避免不必要重渲染
- [ ] App.tsx 改用 useMessages() hook
- [ ] 单元测试 MessagesProvider

**阶段 2：SessionProvider（1 天）**
- [ ] 同上模式抽取

**阶段 3：SettingsProvider（1 天）**
- [ ] 同上模式抽取

**阶段 4：DialogProvider（半天）**
- [ ] 抽取所有 isXxxDialogOpen 状态
- [ ] 提供 openDialog(name) / closeDialog(name) API

**阶段 5：清理 App.tsx（半天）**
- [ ] 删除已迁移的代码
- [ ] App.tsx 应仅保留路由 + Provider 组合 + 顶层布局

#### 验收标准
- App.tsx 行数 < 200
- App.tsx 中 useState 数量 ≤ 3
- React DevTools Profiler：发送消息时只有 MessagesProvider 子树重渲染
- 所有 E2E 测试通过

#### 风险与回滚
- 每阶段独立 PR，便于回滚
- 准备 `feature flag` 切换新旧 Context（可选）

---

### TASK-P1-02：MessageList 引入虚拟滚动

- **优先级**：P1
- **预计耗时**：2-3 天
- **收益**：⭐⭐⭐⭐⭐ （长对话场景性能提升 60%+）
- **风险**：🟡 中（需处理动态高度、消息折叠交互）
- **依赖**：可独立进行

> 对应 Vercel 规则：rerender 列表优化

#### 现状
- `MessageList.tsx` 使用 `VISIBLE_MESSAGE_WINDOW = 15` 仅折叠老消息
- 未折叠的消息全部渲染到 DOM
- HistoryView 已用了 VirtualList，可参考

#### 执行步骤
- [ ] **Step 1**：评估方案
  - 选项 A：复用项目内 `webview/src/components/history/VirtualList.tsx`
  - 选项 B：引入 `react-window`（需评估 vite-plugin-singlefile 兼容性）
  - 选项 C：引入 `@tanstack/react-virtual`（动态高度更友好）
- [ ] **Step 2**：消息高度估算策略
  - 文本消息：估算字符数 → 行高
  - 代码块、图片消息：单独测量
- [ ] **Step 3**：保留消息折叠交互（点击展开 thinking、tool result）
- [ ] **Step 4**：保留滚动锚定（自动滚到底、用户向上滚后停止）
- [ ] **Step 5**：性能基线测试（100 / 500 / 1000 条消息）

#### 验收标准
- 1000 条消息列表滚动流畅（>50 FPS）
- 现有交互（折叠、复制、重缠）全部正常
- 切换会话不闪烁

---

### TASK-P1-03：拆解 useModelProviderState 巨型 Hook

- **优先级**：P1
- **预计耗时**：2-3 天
- **收益**：⭐⭐⭐⭐ （消除 ref 同步反模式）
- **风险**：🟡 中
- **依赖**：建议在 P1-01 之后

> 对应 Vercel 规则：5.9 Split Combined Hook + 5.15 useRef 滥用反模式

#### 现状
```
useModelProviderState.ts (408 行)
├── 18 个 useState（claude / codex 配置混杂）
├── 4 个 useRef（用 useEffect 同步状态 - 反模式）
└── 多个跨 Provider 的回调
```

#### 目标
```
hooks/providers/
├── useClaudeProvider.ts      Claude 专属配置
├── useCodexProvider.ts       Codex 专属配置
├── usePermissionMode.ts      权限模式
└── useUsageTracking.ts       使用统计

hooks/useActiveProvider.ts    切换控制（薄层）
```

#### 执行步骤
- [ ] **Step 1**：阅读全文，画出状态依赖图
- [ ] **Step 2**：识别真正共享的状态 vs 各 provider 独立的状态
- [ ] **Step 3**：用 useReducer 替代多个 useState，消除 ref 同步：
  ```tsx
  // ❌ 反模式
  const [val, setVal] = useState();
  const valRef = useRef(val);
  useEffect(() => { valRef.current = val; }, [val]);

  // ✅ useReducer，state 直接通过 dispatch 闭包访问
  const [state, dispatch] = useReducer(reducer, initial);
  ```
- [ ] **Step 4**：拆分文件，每个 hook 单一职责
- [ ] **Step 5**：单元测试各 hook

#### 验收标准
- 单文件不超过 200 行
- 无 useRef + useEffect 同步 state 的反模式
- Provider 切换功能正常

---

### TASK-P1-04：拆解 9 个巨型组件

- **优先级**：P1
- **预计耗时**：每个 1-2 天，合计 2-3 周
- **收益**：⭐⭐⭐⭐ （可维护性根本提升）
- **风险**：🟡 中（每个独立可控）
- **依赖**：可分别独立进行

#### 任务清单
| 子任务 | 文件 | 行数 | 拆解方向 |
|--------|------|------|---------|
| P1-04-a | `HistoryView.tsx` | 748 | 搜索、列表、时间格式、文件操作分离 |
| P1-04-b | `MarkdownBlock.tsx` | 739 | markdown 渲染、链接、高亮、安全分离 |
| P1-04-c | `ChatInputBox.tsx` | 728 | 输入框、文件标签、自动完成、上下文菜单分离 |
| P1-04-d | `DependencySection/index.tsx` | 724 | 依赖展示、安装、状态分离 |
| P1-04-e | `ProviderDialog.tsx` | 698 | 表单、验证、提交分离 |
| P1-04-f | `ProviderList/index.tsx` | 694 | 列表、操作、登录回调分离 |
| P1-04-g | `messageUtils.ts` | 965 | 按职责拆为 messageTransform / messageFilter / messageRenderer |
| P1-04-h | `changelog.ts` | 2010 | （数据文件，仅做格式优化） |
| P1-04-i | `global.d.ts` | 817 | 按领域拆分到 types/ 子目录 |

#### 通用执行步骤（对每个组件）
- [ ] **Step 1**：阅读理解组件职责
- [ ] **Step 2**：用注释把代码块标记为不同职责区
- [ ] **Step 3**：每个职责区抽为独立的 hook 或子组件
- [ ] **Step 4**：原文件保持向后兼容（重导出新结构）
- [ ] **Step 5**：渐进迁移调用方
- [ ] **Step 6**：删除老入口

#### 验收标准
- 单文件 < 400 行
- 每个文件单一职责
- 现有功能 100% 兼容

---

### TASK-P1-05：消除 useEffect 派生状态反模式

- **优先级**：P1
- **预计耗时**：3-4 天
- **收益**：⭐⭐⭐⭐ （减少不必要重渲染、消除状态漂移 bug 风险）
- **风险**：🟡 中
- **依赖**：建议在 P1-01 之后

> 对应 Vercel 规则：5.1 Calculate Derived State During Rendering + React 19 反模式

#### 现状
- `useDialogManagement.ts:83-96`：3 个相同模式的 useEffect 仅做状态同步
- `useStreamingMessages.ts`：326 行无 useState，全是 ref + effect 同步
- 全项目搜索：`grep -rn "useEffect" webview/src --include="*.ts" --include="*.tsx" | wc -l`

#### 执行步骤
- [ ] **Step 1**：识别所有 `useEffect` 反模式：
  ```tsx
  // ❌ 反模式 1：派生状态
  const [filtered, setFiltered] = useState([]);
  useEffect(() => { setFiltered(list.filter(fn)); }, [list]);

  // ✅ 渲染期计算
  const filtered = useMemo(() => list.filter(fn), [list]);

  // ❌ 反模式 2：响应 prop 变化重置
  useEffect(() => { setSelected(null); }, [tabId]);

  // ✅ key 重置或在事件中处理
  <Component key={tabId} />
  ```
- [ ] **Step 2**：每个 effect 评估：是渲染期可计算？还是响应外部系统？
- [ ] **Step 3**：批量替换为 useMemo / 直接计算 / key 重置
- [ ] **Step 4**：保留的 useEffect 收紧依赖（用主键代替对象）

#### 验收标准
- useEffect 总数减少 30%+
- React DevTools Profiler 显示连环渲染消失

---

### TASK-P1-06：重型组件代码分割（React.lazy + Suspense）

- **优先级**：P1
- **预计耗时**：1-2 天
- **收益**：⭐⭐⭐ （首屏加载提速）
- **风险**：🔴 高（vite-plugin-singlefile 可能限制）
- **依赖**：先完成 P3-01（评估 single file 必要性）

#### 评估前置
- 当前 `vite-plugin-singlefile` 强制单文件输出
- 在单文件场景下，`React.lazy` 仍可用于**延迟挂载**（推迟组件初始化），即使代码已在 bundle 中

#### 候选组件
- Mermaid 图表渲染
- Settings 面板（首屏不需要）
- ChangelogModal（用户主动触发）
- 代码高亮 highlight.js（17 语言全量加载）

#### 执行步骤
- [ ] **Step 1**：用 vite 构建分析工具看 bundle 占比
  ```bash
  cd webview && npx vite-bundle-visualizer
  ```
- [ ] **Step 2**：识别 TOP 5 重型依赖
- [ ] **Step 3**：highlight.js 改为按需注册：
  ```ts
  import hljs from 'highlight.js/lib/core';
  import javascript from 'highlight.js/lib/languages/javascript';
  hljs.registerLanguage('javascript', javascript);
  ```
- [ ] **Step 4**：Settings、Changelog 等用 React.lazy
- [ ] **Step 5**：Suspense fallback 设计 loading 占位

#### 验收标准
- 首屏 bundle 减小 30%+
- 首屏渲染时间提升

---

## 五、P2 顺便执行任务（低收益 / 低成本）

### TASK-P2-01：替换 105 处 `as any`

- **优先级**：P2
- **预计耗时**：1-2 天（持续进行）
- **收益**：⭐⭐ （类型安全的累积收益）
- **风险**：🟢 低
- **执行方式**：每次修改其他任务时顺手清理涉及的 `as any`

#### 执行步骤
- [ ] 全局搜索：`grep -rn "as any" webview/src --include="*.tsx" --include="*.ts"`
- [ ] 按模块分批：每次修改某模块时，顺手清理该模块所有 `as any`
- [ ] 替换为类型守卫：
  ```ts
  // ❌
  const user = data as any;
  user.name; // 类型不安全

  // ✅
  function isUser(x: unknown): x is User {
    return typeof x === 'object' && x !== null && 'name' in x;
  }
  if (isUser(data)) { data.name; }
  ```

---

### TASK-P2-02：清理 hooks 目录组织

- **优先级**：P2
- **预计耗时**：半天
- **收益**：⭐⭐ （查找便捷）
- **风险**：🟢 低
- **依赖**：在完成 P1 拆解后

#### 目标结构
```
hooks/
├── messages/        消息相关
├── session/         会话相关
├── providers/       AI Provider 相关
├── ui/              UI 交互（scroll、dialog、context menu）
└── effects/         副作用相关（windowCallbacks 等）
```

---

### TASK-P2-03：添加 ESLint react-hooks/exhaustive-deps

- **优先级**：P2
- **预计耗时**：2-3 小时
- **收益**：⭐⭐⭐ （持续防止 hooks 错误）
- **风险**：🟡 中（会暴露已有问题）

#### 执行步骤
- [ ] 检查 `webview/` 是否有 ESLint 配置
- [ ] 添加 `eslint-plugin-react-hooks`
- [ ] 配置：
  ```json
  {
    "rules": {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
  ```
- [ ] 暴露的问题逐条评估：是漏依赖还是真要忽略
- [ ] 设置 pre-commit hook 防止退化

---

### TASK-P2-04：添加更多 Error Boundary

- **优先级**：P2
- **预计耗时**：半天
- **收益**：⭐⭐⭐ （崩溃隔离）
- **风险**：🟢 低

#### 关键位置
- `MessageList`（消息渲染失败不应炸全屏）
- `ChatInputBox`（输入崩溃不应丢失会话）
- `MarkdownBlock`（解析错误不应连累整个消息）

---

## 六、P3 暂不执行任务（低收益 / 高成本）

### TASK-P3-01：评估 vite-plugin-singlefile 必要性

- **理由**：插件需要单 HTML 加载到 JCEF webview，**架构约束硬性**
- **建议**：保留，但用 React.lazy 延迟挂载实现"逻辑代码分割"
- **若改动**：影响 Java 端 webview 加载逻辑，跨层重构成本极高

### TASK-P3-02：引入 Zustand / Redux 替代 Context

- **理由**：完成 P1-01（拆 4 个 Context）后，性能已足够
- **建议**：仅在出现明显瓶颈时考虑
- **风险**：引入新依赖、学习成本、API 风格统一

### TASK-P3-03：迁移到 React 19 use() hook

- **理由**：React 19 的 `use()` 替代 useEffect 数据获取，但项目主要数据通过 JCEF 推送（非 fetch）
- **建议**：现有 windowCallbacks 模式已满足，先观察

---

## 七、推荐执行顺序

```
Week 1：清理基础（P0 全做完）
  Day 1: P0-01 console.log + P0-04 事件监听器
  Day 2: P0-03 (window as any)
  Day 3-4: P0-02 列表 memo + P0-05 内联样式
  Day 5: P0-06 TS 严格模式

Week 2-3：架构层（P1-01）
  开始拆解 App.tsx，每个 Context 一个 PR

Week 4：性能层（P1-02）
  MessageList 虚拟滚动

Week 5：Hook 重构（P1-03 + P1-05）
  useModelProviderState 拆解 + useEffect 反模式清理

Week 6-8：组件拆解（P1-04）
  9 个巨型组件，每个 1-2 天

Week 9：代码分割（P1-06）
  React.lazy + 按需注册

持续进行：P2 任务跟随其他 PR 顺便做
```

---

## 八、每个任务的执行模板

> 复制以下模板，开始任意任务时填写

```markdown
## 任务执行记录：TASK-XX-XX

### 开始时间：YYYY-MM-DD HH:MM
### 分支：refactor/xx-xx-task-name

### 执行清单
- [ ] 阅读任务描述
- [ ] 确认前置依赖完成
- [ ] 创建分支
- [ ] 按步骤执行
- [ ] 自测：构建通过
- [ ] 自测：手动测试关键路径
- [ ] 提交 PR
- [ ] Code review
- [ ] 合并

### 遇到的问题
（记录意外）

### 实际耗时：X 小时
### 完成时间：YYYY-MM-DD HH:MM
```

---

## 九、风险控制原则

1. **每个任务独立分支独立 PR**，方便回滚
2. **重要任务做 feature flag**，可以快速关闭新代码路径
3. **优先做局部任务**，避免同时修改多个文件
4. **每完成一个 P0/P1 任务**，至少做一次完整 E2E 流程验证
5. **绝不在同一 PR 中混合架构改动和功能改动**

---

## 十、参考资料

- [Vercel React Best Practices Skill (官方)](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices)
- [SKILL.md - 8 大分类索引](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md)
- [AGENTS.md - 70 条详细规则](https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/AGENTS.md)
- [Introducing: React Best Practices - Vercel Blog](https://vercel.com/blog/introducing-react-best-practices)
- [You Might Not Need an Effect - React 官方](https://react.dev/learn/you-might-not-need-an-effect)
- [项目内 ARCHITECTURE.md](./src/ARCHITECTURE.md)

---

> **文档维护**：每完成一个任务，在对应 `### TASK-XX-XX` 标题前打 `[x]`
> **进度跟踪**：可在 GitHub Issues / Projects 中创建对应 issue，与本文档双向同步

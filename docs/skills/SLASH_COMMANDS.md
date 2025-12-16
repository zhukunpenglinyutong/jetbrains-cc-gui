# 斜杠指令系统 - 完整技术文档

> IDEA 插件版 Claude Code 的斜杠指令（Slash Commands）实现分析

**版本**: v0.1.1
**更新时间**: 2025-12-14
**技术栈**: React + TypeScript + IntelliJ IDEA Plugin

---

## 目录

1. [一句话解释](#一句话解释)
2. [系统架构](#系统架构)
3. [核心流程](#核心流程)
4. [五大核心模块](#五大核心模块)
5. [数据结构定义](#数据结构定义)
6. [关键实现细节](#关键实现细节)
7. [性能优化](#性能优化)
8. [文件映射表](#文件映射表)
9. [常见问题](#常见问题)

---

## 一句话解释

**斜杠指令就是：当用户在输入框行首打 `/` 时，弹出一个命令菜单让用户选择。**

就像你在微信里 `@某人` 会弹出好友列表一样，这里打 `/` 会弹出命令列表。

---

## 系统架构

### 架构拓扑图

```
┌─────────────────────────────────────────────────────────────────────┐
│                       IDEA 插件架构 (v0.1.1)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                    Java 后端 (IDEA Plugin)                     │ │
│  ├───────────────────────────────────────────────────────────────┤ │
│  │  ClaudeSDKBridge.java                                        │ │
│  │  ↓ 接收 refresh_slash_commands 请求                          │ │
│  │  ↓ 调用 Claude SDK 获取命令列表                               │ │
│  │  ↓ 通过 JCEF Bridge 发送 updateSlashCommands 回调             │ │
│  │                                                               │ │
│  │  SlashCommandCache.java (新增)                                │ │
│  │  ↓ 缓存命令列表，避免重复请求 SDK                              │ │
│  └────────────────────────────┬──────────────────────────────────┘ │
│                               │ JCEF Bridge                         │
│                               ▼                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                    React WebView 前端                          │ │
│  ├───────────────────────────────────────────────────────────────┤ │
│  │                                                               │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │           ChatInputBox.tsx (主组件)                      │ │ │
│  │  │  ┌───────────────────────────────────────────────────┐  │ │ │
│  │  │  │  useTriggerDetection (触发检测 Hook)               │  │ │ │
│  │  │  │  • detectSlashTrigger() - 仅检测行首的 /           │  │ │ │
│  │  │  │  • getCursorPosition() - 获取光标位置              │  │ │ │
│  │  │  └───────────────────────────────────────────────────┘  │ │ │
│  │  │                                                         │ │ │
│  │  │  ┌───────────────────────────────────────────────────┐  │ │ │
│  │  │  │  useCompletionDropdown (补全管理 Hook)             │  │ │ │
│  │  │  │  • 防抖搜索 (200ms)                                │  │ │ │
│  │  │  │  • AbortController 取消                            │  │ │ │
│  │  │  │  • 键盘导航处理                                    │  │ │ │
│  │  │  └───────────────────────────────────────────────────┘  │ │ │
│  │  │                                                         │ │ │
│  │  │  ┌───────────────────────────────────────────────────┐  │ │ │
│  │  │  │  slashCommandProvider (数据提供者)                 │  │ │ │
│  │  │  │  • 缓存从后端接收的命令                            │  │ │ │
│  │  │  │  • 过滤隐藏命令 (HIDDEN_COMMANDS)                  │  │ │ │
│  │  │  │  • 发送 refresh_slash_commands 请求               │  │ │ │
│  │  │  └───────────────────────────────────────────────────┘  │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  │                                                               │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │           CompletionDropdown 组件                        │ │ │
│  │  │  • 位置计算 (锚定在 / 字符下方)                          │ │ │
│  │  │  • 键盘/鼠标导航模式                                     │ │ │
│  │  │  • DropdownItem 渲染                                     │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  │                                                               │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 | 文件位置 |
|-----|------|---------|
| 后端 | Java + IntelliJ SDK | `src/main/java/com/github/claudecodegui/` |
| 桥接 | JCEF Bridge | `ai-bridge/` |
| 前端框架 | React 18 + TypeScript | `webview/src/` |
| 状态管理 | React Hooks | `webview/src/components/ChatInputBox/hooks/` |
| UI 组件 | 自定义 React 组件 | `webview/src/components/ChatInputBox/` |

---

## 核心流程

### 完整数据流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         完整数据流程                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. 用户在输入框行首输入 "/"                                          │
│     └─→ ChatInputBox 触发 onInput 事件                              │
│     └─→ handleInput() 调用 detectAndTriggerCompletion()             │
│                                                                     │
│  2. 触发检测器检测                                                    │
│     └─→ useTriggerDetection.detectTrigger(text, cursorPos)          │
│     └─→ detectSlashTrigger() 检查 / 是否在行首                       │
│     └─→ 返回 TriggerQuery: { trigger: '/', query: '', start, end }  │
│                                                                     │
│  3. 打开下拉菜单                                                      │
│     └─→ commandCompletion.open(position, trigger)                   │
│     └─→ commandCompletion.updateQuery(trigger)                      │
│     └─→ 触发防抖搜索 (200ms)                                        │
│                                                                     │
│  4. 数据加载                                                          │
│     └─→ slashCommandProvider(query, signal) 被调用                  │
│     └─→ 检查 cachedSdkCommands 是否为空                             │
│     └─→ 如果为空，发送 refresh_slash_commands 到后端                │
│     └─→ 后端通过 window.updateSlashCommands(json) 返回数据         │
│     └─→ 更新 cachedSdkCommands                                      │
│     └─→ 过滤隐藏命令 (HIDDEN_COMMANDS)                              │
│     └─→ 返回过滤后的命令列表                                        │
│                                                                     │
│  5. 数据转换                                                          │
│     └─→ commandToDropdownItem(command) 转换为 UI 格式               │
│     └─→ 更新 items 状态                                             │
│                                                                     │
│  6. 渲染下拉菜单                                                      │
│     └─→ CompletionDropdown 组件根据 isOpen 和 items 渲染            │
│     └─→ 每个项用 DropdownItem 渲染                                  │
│                                                                     │
│  7. 用户导航与选择                                                    │
│     ┌──────────────────────────────────────────────────────────────┐│
│     │ 键盘导航:                                                     ││
│     │   ↓ 键 → activeIndex = (activeIndex + 1) % count            ││
│     │   ↑ 键 → activeIndex = (activeIndex - 1 + count) % count    ││
│     │   Enter/Tab → selectActive() 选择当前项                      ││
│     │   Escape → close() 关闭菜单                                  ││
│     ├──────────────────────────────────────────────────────────────┤│
│     │ 鼠标导航:                                                     ││
│     │   mouseenter → handleMouseEnter(index) 更新 activeIndex     ││
│     │   click → selectIndex(index) 选择项                          ││
│     └──────────────────────────────────────────────────────────────┘│
│                                                                     │
│  8. 命令选择回调执行                                                  │
│     └─→ onSelect(command, query) 回调执行                           │
│     └─→ replaceText() 用 "/command " 替换 "/" 部分                  │
│     └─→ 更新输入框内容                                              │
│     └─→ 关闭下拉菜单                                                │
│                                                                     │
│  9. 用户按 Enter 发送消息                                            │
│     └─→ handleSubmit() 触发                                         │
│     └─→ onSubmit?.(content, attachments) 发送到后端                │
│     └─→ 后端执行对应的斜杠命令                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 简化流程图

```
用户输入 "/" (行首)
      │
      ▼
┌─────────────┐
│  检测到 /   │  ← useTriggerDetection
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 获取命令列表 │  ← slashCommandProvider (缓存 + 后端请求)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 弹出下拉菜单 │  ← CompletionDropdown
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 用户选择命令 │  ← 键盘 ↑↓ 或鼠标点击
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 替换输入文本 │  ← replaceText()
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 执行命令    │  ← 用户按回车后发送给后端
└─────────────┘
```

---

## 五大核心模块

用 **餐厅点餐** 来比喻：

| 模块 | 比喻 | 做什么 |
|------|------|--------|
| **触发检测器** | 服务员的眼睛 | 监视用户有没有在行首输入 `/` |
| **命令缓存** | 菜单本 | 存储从后端获取的所有可用命令 |
| **数据提供者** | 后厨传菜员 | 根据用户输入过滤命令，隐藏不适用的命令 |
| **下拉菜单** | 菜单展示板 | 显示可选的命令列表 |
| **键盘导航** | 点餐手势 | 处理上下键和回车选择 |

### 模块 1：触发检测器 (useTriggerDetection)

**位置**: `webview/src/components/ChatInputBox/hooks/useTriggerDetection.ts`

**核心特点**:
- 仅检测**行首**的 `/`（与原 VSCode 版本不同）
- 同时支持 `@` 文件引用触发

```typescript
/**
 * 检测 / 斜杠命令触发（仅行首）
 */
function detectSlashTrigger(text: string, cursorPosition: number): TriggerQuery | null {
  // 从光标位置向前查找 /
  let start = cursorPosition - 1;
  while (start >= 0) {
    const char = text[start];

    // 遇到空格或换行，停止搜索
    if (char === ' ' || char === '\t' || char === '\n') {
      return null;
    }

    // 找到 /
    if (char === '/') {
      // 检查 / 前是否为行首
      const isLineStart = start === 0 || text[start - 1] === '\n';
      if (isLineStart) {
        return {
          trigger: '/',
          query: text.slice(start + 1, cursorPosition),
          start,
          end: cursorPosition,
        };
      }
      return null; // / 不在行首
    }
    start--;
  }
  return null;
}
```

**检测示例**：

| 输入 | 光标位置 | 检测结果 |
|------|---------|---------|
| `/cle` | 4 | ✓ `{ query: "cle", start: 0 }` |
| `hello /cle` | 10 | ✗ `null` (/ 不在行首) |
| `行1\n/cle` | 6 | ✓ `{ query: "cle", start: 3 }` |

### 模块 2：命令缓存 (slashCommandProvider)

**位置**: `webview/src/components/ChatInputBox/providers/slashCommandProvider.ts`

**核心特点**:
- 从后端接收命令并缓存
- 过滤隐藏命令（IDEA 插件不适用的命令）
- 首次加载显示加载提示

```typescript
/**
 * 隐藏的命令列表
 * 这些命令是 Claude Code CLI 内置命令，不应在 IDEA 插件中显示
 */
const HIDDEN_COMMANDS = new Set([
  '/clear',        // 清除对话历史
  '/context',      // 上下文可视化
  '/cost',         // 显示费用
  '/init',         // 初始化 CLAUDE.md
  '/pr-comments',  // PR 评论
  '/release-notes',// 发布说明
  '/review',       // 审查 PR
  '/security-review', // 安全审查
  '/todo',         // 待办事项
]);

// SDK 命令缓存
let cachedSdkCommands: CommandItem[] = [];
let isInitialLoading = true;

/**
 * 斜杠命令数据提供者
 */
export async function slashCommandProvider(
  query: string,
  signal: AbortSignal
): Promise<CommandItem[]> {
  // 确保回调已设置
  setupSlashCommandsCallback();

  // 如果缓存为空且正在首次加载，请求后端刷新
  if (cachedSdkCommands.length < 20 && !refreshRequested && isInitialLoading) {
    sendBridgeEvent('refresh_slash_commands');
    refreshRequested = true;
  }

  // 如果缓存为空，返回加载提示
  if (cachedSdkCommands.length === 0 && isInitialLoading) {
    return [{
      id: '__loading__',
      label: '正在加载斜杠指令...',
      description: '首次加载可能需要 1-2 秒',
      category: 'system',
    }];
  }

  // 过滤隐藏命令和搜索
  return filterCommands(cachedSdkCommands, query);
}
```

### 模块 3：数据提供者与转换

**位置**: `webview/src/components/ChatInputBox/providers/slashCommandProvider.ts`

```typescript
/**
 * 将 CommandItem 转换为 DropdownItemData
 */
export function commandToDropdownItem(command: CommandItem): DropdownItemData {
  return {
    id: command.id,
    label: command.label,
    description: command.description,
    icon: 'codicon-terminal',
    type: 'command',
    data: { command },
  };
}
```

### 模块 4：下拉菜单 (CompletionDropdown)

**位置**: `webview/src/components/ChatInputBox/Dropdown/`

**关键功能**：
- 位置计算（锚定在 `/` 字符下方）
- 高亮状态管理
- 键盘/鼠标导航模式切换
- 加载状态和空状态显示

### 模块 5：补全管理 (useCompletionDropdown)

**位置**: `webview/src/components/ChatInputBox/hooks/useCompletionDropdown.ts`

**核心功能**：
- 防抖搜索（200ms）
- AbortController 取消请求
- 竞态条件防护
- 键盘事件处理

```typescript
export function useCompletionDropdown<T>({
  trigger,
  provider,
  toDropdownItem,
  onSelect,
  debounceMs = 200,
}: CompletionDropdownOptions<T>) {
  const [state, setState] = useState<CompletionDropdownState>({...});

  // AbortController 用于取消请求
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * 防抖搜索
   */
  const debouncedSearch = useCallback((query: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(() => {
      search(query);
    }, debounceMs);
  }, [search, debounceMs]);

  /**
   * 处理键盘事件
   */
  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    if (!currentState.isOpen) return false;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setState(prev => ({
          ...prev,
          activeIndex: (prev.activeIndex + 1) % selectableCount,
        }));
        return true;

      case 'ArrowUp':
        e.preventDefault();
        setState(prev => ({
          ...prev,
          activeIndex: (prev.activeIndex - 1 + selectableCount) % selectableCount,
        }));
        return true;

      case 'Enter':
      case 'Tab':
        e.preventDefault();
        selectActive();
        return true;

      case 'Escape':
        e.preventDefault();
        close();
        return true;
    }
    return false;
  }, [selectActive, close]);

  return {
    isOpen: state.isOpen,
    items: state.items,
    activeIndex: state.activeIndex,
    // ...
    handleKeyDown,
    selectActive,
  };
}
```

---

## 数据结构定义

### TriggerQuery (触发查询)

```typescript
interface TriggerQuery {
  trigger: string;   // 触发符，'/' 或 '@'
  query: string;     // 查询文本 (不包括触发符)
  start: number;     // 触发符在文本中的位置
  end: number;       // 查询结束位置（光标位置）
}

// 示例：
// 输入: "/workflow"
// TriggerQuery: { trigger: '/', query: 'workflow', start: 0, end: 9 }
```

### CommandItem (命令项)

```typescript
interface CommandItem {
  id: string;          // 命令 ID
  label: string;       // 显示标签，如 "/workflow:plan"
  description: string; // 命令描述
  category: string;    // 分类: 'workflow', 'memory', 'task', 'user' 等
}
```

### DropdownItemData (下拉项)

```typescript
interface DropdownItemData {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  type: 'command' | 'file' | 'separator' | 'section-header';
  data?: any;
}
```

### DropdownPosition (位置)

```typescript
interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  height: number;
}
```

---

## 关键实现细节

### 1. 行首检测（与 VSCode 版本的区别）

**原 VSCode 版本**：
- 使用正则 `(?:^|\s)/[^\s/]*` 匹配行首或空格后的 `/`

**IDEA 插件版本**：
- 仅检测**行首**的 `/`
- 空格后的 `/` 不会触发

```typescript
// 检查 / 前是否为行首
const isLineStart = start === 0 || text[start - 1] === '\n';
if (isLineStart) {
  return { trigger: '/', query, start, end };
}
return null; // / 不在行首
```

### 2. 命令过滤

IDEA 插件会过滤掉不适用的命令：

```typescript
const HIDDEN_COMMANDS = new Set([
  '/clear',        // 在 IDEA 中无意义
  '/context',      // CLI 特定功能
  '/cost',         // CLI 特定功能
  '/init',         // CLI 特定功能
  '/pr-comments',  // CLI 特定功能
  '/release-notes',// CLI 特定功能
  '/review',       // CLI 特定功能
  '/security-review', // CLI 特定功能
  '/todo',         // CLI 特定功能
]);
```

### 3. 后端通信机制

```typescript
// 前端发送请求
sendBridgeEvent('refresh_slash_commands');

// 后端返回数据（通过 JCEF Bridge）
window.updateSlashCommands(jsonString);

// 前端注册回调
window.updateSlashCommands = (json: string) => {
  const commands = JSON.parse(json);
  cachedSdkCommands = commands.map(cmd => ({...}));
};
```

### 4. 防抖与取消

```typescript
// 1. 清除之前的定时器
if (debounceTimerRef.current) {
  clearTimeout(debounceTimerRef.current);
}

// 2. 取消之前的请求
if (abortControllerRef.current) {
  abortControllerRef.current.abort();
}

// 3. 设置新的定时器
debounceTimerRef.current = window.setTimeout(() => {
  abortControllerRef.current = new AbortController();
  search(query);
}, 200);
```

---

## 性能优化

| 优化 | 位置 | 效果 |
|-----|------|------|
| **防抖 (200ms)** | `useCompletionDropdown.ts` | 减少搜索次数 |
| **AbortController** | `useCompletionDropdown.ts` | 取消前一个请求 |
| **命令缓存** | `slashCommandProvider.ts` | 避免重复请求后端 |
| **首次加载提示** | `slashCommandProvider.ts` | 改善用户体验 |
| **导航模式隔离** | `useCompletionDropdown.ts` | 减少不必要的样式更新 |

---

## 文件映射表

| 功能 | 文件位置 |
|-----|---------|
| **主组件** | `webview/src/components/ChatInputBox/ChatInputBox.tsx` |
| **触发检测** | `webview/src/components/ChatInputBox/hooks/useTriggerDetection.ts` |
| **补全管理** | `webview/src/components/ChatInputBox/hooks/useCompletionDropdown.ts` |
| **斜杠命令提供者** | `webview/src/components/ChatInputBox/providers/slashCommandProvider.ts` |
| **文件引用提供者** | `webview/src/components/ChatInputBox/providers/fileReferenceProvider.ts` |
| **下拉菜单组件** | `webview/src/components/ChatInputBox/Dropdown/` |
| **类型定义** | `webview/src/components/ChatInputBox/types.ts` |
| **样式** | `webview/src/components/ChatInputBox/styles.css` |
| **Java 后端桥接** | `src/main/java/com/github/claudecodegui/ClaudeSDKBridge.java` |
| **命令缓存** | `src/main/java/com/github/claudecodegui/cache/SlashCommandCache.java` |

---

## 常见问题

### Q1: 为什么只在行首触发？

**A**: IDEA 插件版本设计为仅在行首触发斜杠命令，这与 VSCode 版本不同。这是为了：
1. 避免在输入路径时误触发（如 `/Users/...`）
2. 更符合命令行的使用习惯

### Q2: 为什么有些命令被隐藏？

**A**: `HIDDEN_COMMANDS` 中的命令是 Claude Code CLI 的内置命令，它们在 IDEA 插件环境中：
- 没有意义（如 `/clear` 清除 CLI 历史）
- 不可用（如 `/pr-comments` 需要 Git 集成）
- 由 IDEA 提供替代方案

### Q3: 首次加载为什么需要时间？

**A**: 首次加载时需要：
1. 通过 JCEF Bridge 向 Java 后端发送请求
2. Java 后端调用 Claude SDK 获取命令列表
3. 命令列表通过 Bridge 返回前端
4. 前端缓存命令以供后续使用

后续使用会直接使用缓存，无需等待。

### Q4: 如何添加新的斜杠命令？

**A**: 斜杠命令来自 Claude SDK，由用户的 `.claude/commands/` 目录定义。插件会自动加载这些命令。

如果要在前端过滤或修改命令显示：
1. 编辑 `slashCommandProvider.ts` 中的 `HIDDEN_COMMANDS`
2. 或修改 `commandToDropdownItem()` 函数

### Q5: 键盘导航支持哪些按键？

| 按键 | 功能 |
|------|------|
| `↓` | 选择下一项 |
| `↑` | 选择上一项 |
| `Enter` | 确认选择 |
| `Tab` | 确认选择 |
| `Escape` | 关闭菜单 |

---

## 总结

IDEA 插件版的斜杠指令系统是一个**模块化设计**：

1. **触发检测**: 独立的检测逻辑，仅行首触发 ✓
2. **命令缓存**: 从后端获取并缓存命令 ✓
3. **命令过滤**: 隐藏不适用的 CLI 命令 ✓
4. **补全管理**: 通用的下拉菜单管理器 ✓
5. **键盘导航**: 独立的导航处理 ✓
6. **UI 组件**: 完全解耦的显示层 ✓

这个架构使得添加新功能（如标签补全、代码片段等）变得非常简单。

---

*文档最后更新: 2025-12-14*
*项目版本: v0.1.1*

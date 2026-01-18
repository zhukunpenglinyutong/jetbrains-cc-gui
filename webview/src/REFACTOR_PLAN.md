# App.tsx 重构计划

## 📊 当前状态
- **原始行数**: 3143 行
- **当前行数**: 2795 行
- **已减少**: ~348 行 (11%)
- **目标**: 拆分为多个模块，每个文件 < 1000 行

---

## ✅ 已完成的模块

### 工具函数 (阶段一已完成)

| 文件 | 行数 | 状态 |
|------|------|------|
| `utils/messageUtils.ts` | ~250 | ✅ 已创建 |
| `utils/localizationUtils.ts` | ~100 | ✅ 已创建 |
| `utils/helpers.ts` | +15 | ✅ 添加 formatTime |

### 自定义 Hooks (阶段二已完成)

| 文件 | 行数 | App.tsx 集成状态 |
|------|------|------|
| `hooks/useScrollBehavior.ts` | ~115 | ✅ 已集成 |
| `hooks/useDialogManagement.ts` | ~228 | ✅ 已集成 |
| `hooks/useSessionManagement.ts` | ~231 | ✅ 已集成 |
| `hooks/useStreamingMessages.ts` | ~229 | ⏳ 待集成 |
| `hooks/index.ts` | ~6 | ✅ Barrel export |

---

## 📖 如何在 App.tsx 中使用新模块

### 1. 导入新模块

```typescript
// 在 App.tsx 顶部添加
import {
  useScrollBehavior,
  useDialogManagement,
  useSessionManagement,
  useStreamingMessages,
  THROTTLE_INTERVAL
} from './hooks';
import { createLocalizeMessage } from './utils/localizationUtils';
import {
  normalizeBlocks,
  getMessageText,
  shouldShowMessage,
  getContentBlocks,
  mergeConsecutiveAssistantMessages
} from './utils/messageUtils';
import { formatTime } from './utils/helpers';
import { sendBridgeEvent } from './utils/bridge';
```

### 2. 使用 useScrollBehavior

```typescript
// 替换 App.tsx 中的滚动相关代码
const {
  messagesContainerRef,
  messagesEndRef,
  inputAreaRef,
  isUserAtBottomRef,
  isAutoScrollingRef,
  scrollToBottom,
} = useScrollBehavior({
  currentView,
  messages,
  expandedThinking,
  loading,
  streamingActive,
});

// 删除 App.tsx 中的:
// - messagesContainerRef, messagesEndRef, inputAreaRef refs (178-180行)
// - isUserAtBottomRef, isAutoScrollingRef refs (182, 190行)
// - scrollToBottom useCallback (1493-1516行)
// - 滚动事件监听 useEffect (1476-1491行)
// - 自动滚动 useLayoutEffect (1518-1534行)
```

### 3. 使用 useDialogManagement

```typescript
const {
  // Permission dialog
  permissionDialogOpen,
  currentPermissionRequest,
  permissionDialogOpenRef,
  currentPermissionRequestRef,
  pendingPermissionRequestsRef,
  openPermissionDialog,
  handlePermissionApprove,
  handlePermissionApproveAlways,
  handlePermissionSkip,

  // AskUserQuestion dialog
  askUserQuestionDialogOpen,
  currentAskUserQuestionRequest,
  openAskUserQuestionDialog,
  handleAskUserQuestionSubmit,
  handleAskUserQuestionCancel,

  // Rewind dialog
  rewindDialogOpen,
  setRewindDialogOpen,
  currentRewindRequest,
  setCurrentRewindRequest,
  isRewinding,
  setIsRewinding,
  rewindSelectDialogOpen,
  setRewindSelectDialogOpen,
} = useDialogManagement({ t });

// 删除 App.tsx 中的:
// - 权限弹窗状态 (104-108行)
// - AskUserQuestion 弹窗状态 (110-115行)
// - Rewind 弹窗状态 (117-122行)
// - openPermissionDialog, openAskUserQuestionDialog 函数 (219-231行)
// - 权限队列处理 useEffect (233-249行)
// - handlePermissionApprove/Skip/Always 函数 (1843-1941行)
// - handleAskUserQuestion* 函数 (1885-1920行)
```

### 4. 使用 useSessionManagement

```typescript
const {
  showNewSessionConfirm,
  showInterruptConfirm,
  suppressNextStatusToastRef,
  createNewSession,
  handleConfirmNewSession,
  handleCancelNewSession,
  handleConfirmInterrupt,
  handleCancelInterrupt,
  loadHistorySession,
  deleteHistorySession,
  exportHistorySession,
  toggleFavoriteSession,
  updateHistoryTitle,
} = useSessionManagement({
  messages,
  loading,
  historyData,
  currentSessionId,
  setHistoryData,
  setMessages,
  setCurrentView,
  setCurrentSessionId,
  setUsagePercentage,
  setUsageUsedTokens,
  addToast,
  t,
});

// 删除 App.tsx 中的:
// - showNewSessionConfirm, showInterruptConfirm 状态 (88-89行)
// - suppressNextStatusToastRef (101行)
// - createNewSession, handleConfirmNewSession 等函数 (1791-1838行)
// - loadHistorySession, deleteHistorySession 等函数 (1954-2060行)
```

### 5. 使用 useStreamingMessages

```typescript
const streaming = useStreamingMessages();

// 在巨型 useEffect 中使用 streaming 返回的 refs 和辅助函数:
// - streaming.streamingContentRef
// - streaming.isStreamingRef
// - streaming.findLastAssistantIndex(list)
// - streaming.getOrCreateStreamingAssistantIndex(list)
// - streaming.patchAssistantForStreaming(assistant)
// 等等...

// 删除 App.tsx 中的:
// - 流式传输状态 refs (184-207行)
// - useEffect 内的辅助函数 (513-603行)
```

### 6. 使用工具函数

```typescript
// 创建本地化函数
const localizeMessage = createLocalizeMessage(t);

// 在 useMemo 中使用
const mergedMessages = useMemo(() => {
  const getMessageTextFn = (msg: ClaudeMessage) => getMessageText(msg, localizeMessage, t);
  const normalizeBlocksFn = (raw?: ClaudeRawMessage | string) => normalizeBlocks(raw, localizeMessage, t);

  const visible = messages.filter((msg) => shouldShowMessage(msg, getMessageTextFn, normalizeBlocksFn, t));
  return mergeConsecutiveAssistantMessages(visible, normalizeBlocksFn);
}, [messages, localizeMessage, t]);

// 删除 App.tsx 中的:
// - localizeMessage 函数 (2063-2158行)
// - getMessageText 函数 (2160-2191行)
// - shouldShowMessage 函数 (2193-2237行)
// - normalizeBlocks 函数 (2239-2351行)
// - getContentBlocks 函数 (2353-2371行)
// - mergedMessages useMemo 中的合并逻辑 (2373-2421行)
```

---

## ⏳ 待完成的工作

### 文件大小对比
| 模块 | 行数 | 说明 |
|------|------|------|
| **App.tsx (重构前)** | **3142** | 单一巨型文件 |
| **App.tsx (重构后)** | **~500** | 只保留主要组合逻辑 |
| hooks/useStreamingMessages.ts | ~200 | 流式消息处理 |
| hooks/useBridgeCallbacks.ts | ~300 | 桥接回调管理 |
| hooks/usePermissions.ts | ~150 | 权限管理 |
| hooks/useSessionManagement.ts | ~100 | 会话管理 |
| hooks/useHistoryManagement.ts | ~100 | 历史记录管理 |
| utils/messageUtils.ts | ~300 | 消息处理工具 |
| utils/localizationUtils.ts | ~100 | 本地化工具 |
| utils/bridgeUtils.ts | ~50 | 桥接通信工具 |
| components/MessageList.tsx | ~300 | 消息列表组件 |
| components/MessageItem.tsx | ~200 | 单条消息组件 |
| components/Header.tsx | ~100 | 头部组件 |
| components/EmptyState.tsx | ~50 | 空状态组件 |
| contexts/AppStateContext.tsx | ~150 | 全局状态管理 |
| contexts/DialogContext.tsx | ~100 | 对话框状态管理 |
| types/app.ts | ~50 | 类型定义 |
| **总计** | **~2650** | 拆分为16个模块 |

### 优势
✅ 每个文件 < 1000 行，符合项目规范
✅ 职责清晰，易于维护
✅ 更好的代码复用
✅ 更容易编写单元测试
✅ 更好的可读性和可维护性

---

## 🚀 实施建议

### 执行顺序
1. **阶段一** → 先抽离 Hooks（不影响现有功能）
2. **阶段二** → 再抽离工具函数（独立模块）
3. **阶段三** → 拆分子组件（UI 分离）
4. **阶段四** → 状态管理优化（架构优化）
5. **阶段五** → 类型定义整理（最终清理）

### 注意事项
- 每完成一个阶段，立即测试功能完整性
- 保持 Git 提交的原子性（每个模块一个 commit）
- 更新 ARCHITECTURE.md 文档（如果相关组件有此文档）
- 确保所有导入路径正确
- 保持功能100%不变（纯重构，不修改逻辑）

---

## 📝 检查清单

### 重构前
- [ ] 确认当前代码功能正常
- [ ] 创建功能测试清单
- [ ] 备份当前代码（Git 分支）

### 重构中
- [ ] 每完成一个模块，运行测试
- [ ] 检查 TypeScript 类型错误
- [ ] 检查 ESLint 警告
- [ ] 确保导入路径正确

### 重构后
- [ ] 功能完整性测试
- [ ] 性能测试（确保没有性能退化）
- [ ] 代码审查
- [ ] 更新相关文档
- [ ] 提交 Git commit

---

## 🎯 最终目标

将 3142 行的单一巨型文件重构为：
- **1个主文件** (~500行) - App.tsx
- **5个自定义 Hooks** (~850行)
- **3个工具模块** (~450行)
- **4个子组件** (~650行)
- **2个上下文 Provider** (~250行)
- **1个类型定义** (~50行)

**共16个模块，总计约2750行，平均每个模块约170行。**

每个模块职责清晰，符合单一职责原则，易于维护和测试。

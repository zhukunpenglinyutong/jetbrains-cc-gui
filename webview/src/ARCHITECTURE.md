# App.tsx Architecture

## Overview

App.tsx is the main entry point of the webview application, serving as the orchestration layer for a chat-based AI assistant interface. After refactoring, it has been reduced from 3143 to ~1170 lines through extraction of custom hooks and components.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                              App.tsx                                │
│                         (Orchestration Layer)                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      View Router                             │   │
│  │   ┌──────────┐    ┌──────────────┐    ┌──────────────┐     │   │
│  │   │   Chat   │    │   History    │    │   Settings   │     │   │
│  │   │   View   │    │    View      │    │    View      │     │   │
│  │   └──────────┘    └──────────────┘    └──────────────┘     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Custom Hooks Layer                        │   │
│  │  ┌─────────────────┐  ┌─────────────────┐                   │   │
│  │  │useWindowCallbacks│  │useStreamingMessages│               │   │
│  │  └─────────────────┘  └─────────────────┘                   │   │
│  │  ┌─────────────────┐  ┌─────────────────┐                   │   │
│  │  │useDialogManagement│ │useSessionManagement│               │   │
│  │  └─────────────────┘  └─────────────────┘                   │   │
│  │  ┌─────────────────┐  ┌─────────────────┐                   │   │
│  │  │useRewindHandlers │  │useScrollBehavior │                 │   │
│  │  └─────────────────┘  └─────────────────┘                   │   │
│  │  ┌─────────────────┐  ┌─────────────────┐                   │   │
│  │  │ useHistoryLoader │  │  useUsageStats  │                  │   │
│  │  └─────────────────┘  └─────────────────┘                   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Java Bridge Layer                         │   │
│  │              (window.xxx callbacks registration)             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
webview/src/
├── App.tsx                    # Main orchestration component
├── hooks/
│   ├── index.ts               # Barrel exports
│   ├── useWindowCallbacks.ts  # Java bridge callbacks (~770 lines)
│   ├── useStreamingMessages.ts# Streaming message handling
│   ├── useDialogManagement.ts # Dialog state management
│   ├── useSessionManagement.ts# Session CRUD operations
│   ├── useRewindHandlers.ts   # Rewind functionality (~135 lines)
│   ├── useScrollBehavior.ts   # Auto-scroll behavior
│   ├── useHistoryLoader.ts    # History data loading (~42 lines)
│   └── useUsageStats.ts       # Usage statistics polling (~29 lines)
├── components/
│   ├── ChatHeader/            # Header navigation
│   ├── WelcomeScreen/         # Empty state welcome
│   ├── MessageItem/           # Message rendering
│   │   ├── MessageItem.tsx    # Main message component
│   │   └── ContentBlockRenderer.tsx # Content block rendering
│   ├── ChatInputBox/          # Input area with controls
│   ├── history/               # History view components
│   └── settings/              # Settings view components
└── utils/
    ├── toolConstants.ts       # Shared tool name constants (READ/EDIT/BASH tools)
    ├── localizationUtils.ts   # Translation helpers
    ├── messageUtils.ts        # Message processing utilities
    └── helpers.ts             # General helpers
```

## Custom Hooks

### useWindowCallbacks (~770 lines)
Handles all `window.xxx` callback registrations for Java bridge communication.

**Responsibilities:**
- Message callbacks (updateMessages, clearMessages, addErrorMessage)
- Streaming callbacks (onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd)
- Status callbacks (updateStatus, showLoading, showThinkingStatus)
- Settings callbacks (onUsageUpdate, onModeChanged, onModelChanged)
- Dialog callbacks (showPermissionDialog, showAskUserQuestionDialog)
- Context callbacks (addSelectionInfo, addCodeSnippet, clearSelectionInfo)
- Agent callbacks (onSelectedAgentReceived, onSelectedAgentChanged)
- Rewind callback (onRewindResult)

**Dependencies:**
- All state setters from App.tsx
- Streaming refs from useStreamingMessages
- Dialog handlers from useDialogManagement

### useStreamingMessages
Manages streaming message state and rendering helpers.

**Exports:**
- `streamingContentRef`, `isStreamingRef` - Current streaming state
- `findLastAssistantIndex()` - Find last assistant message
- `extractRawBlocks()` - Extract content blocks from raw message
- `getOrCreateStreamingAssistantIndex()` - Get/create streaming message index
- `patchAssistantForStreaming()` - Patch message with streaming segments

### useDialogManagement
Manages all dialog states with request queuing.

**Handles:**
- Permission dialog (approve/skip/approve-always)
- AskUserQuestion dialog (submit/cancel)
- Rewind dialog (confirm/cancel)
- Rewind select dialog

### useSessionManagement
Handles session CRUD operations.

**Operations:**
- `createNewSession()` - Create new chat session
- `loadHistorySession()` - Load session from history
- `deleteHistorySession()` - Delete session
- `exportHistorySession()` - Export session to file
- `toggleFavoriteSession()` - Toggle session favorite status
- `updateHistoryTitle()` - Update session title

### useRewindHandlers (~135 lines)
Handles rewind (time travel) functionality.

**Handlers:**
- `handleRewindClick()` - Initiate rewind from message
- `handleRewindConfirm()` - Confirm rewind operation
- `handleRewindCancel()` - Cancel rewind
- `handleOpenRewindSelectDialog()` - Open rewind selection
- `handleRewindSelect()` - Select message to rewind to

### useScrollBehavior
Manages auto-scroll behavior during streaming.

**Returns:**
- `messagesContainerRef` - Container ref for scroll
- `messagesEndRef` - End marker ref
- `inputAreaRef` - Input area ref
- `isUserAtBottomRef` - Track if user is at bottom

### useHistoryLoader (~42 lines)
Loads history data when view changes to 'history'.

### useUsageStats (~29 lines)
Polls usage statistics every 60 seconds.

## State Management

### View State
```typescript
type ViewMode = 'chat' | 'history' | 'settings';
const [currentView, setCurrentView] = useState<ViewMode>('chat');
```

### Message State
```typescript
const [messages, setMessages] = useState<ClaudeMessage[]>([]);
const [loading, setLoading] = useState(false);
const [streamingActive, setStreamingActive] = useState(false);
const [isThinking, setIsThinking] = useState(false);
```

### Provider State
```typescript
const [currentProvider, setCurrentProvider] = useState('claude');
const [selectedClaudeModel, setSelectedClaudeModel] = useState(CLAUDE_MODELS[0].id);
const [selectedCodexModel, setSelectedCodexModel] = useState(CODEX_MODELS[0].id);
const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
```

### Context State
```typescript
const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
const [selectedAgent, setSelectedAgent] = useState<SelectedAgent | null>(null);
```

## Data Flow

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Java      │────▶│ window.xxx   │────▶│  App State  │
│  Backend    │     │  callbacks   │     │             │
└─────────────┘     └──────────────┘     └─────────────┘
                                                │
                                                ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Java      │◀────│sendBridgeEvent│◀────│  User       │
│  Backend    │     │              │     │  Actions    │
└─────────────┘     └──────────────┘     └─────────────┘
```

### Message Flow
1. User types in ChatInputBox
2. `handleSubmit()` creates user message and calls `sendBridgeEvent('send_message', ...)`
3. Java backend processes and calls `window.onStreamStart()`
4. Streaming deltas arrive via `window.onContentDelta()` / `window.onThinkingDelta()`
5. Stream ends via `window.onStreamEnd()`
6. Full message sync via `window.updateMessages()`

### Permission Flow
1. Backend requests permission via `window.showPermissionDialog()`
2. User approves/skips via `handlePermissionApprove()` / `handlePermissionSkip()`
3. Decision sent via `sendBridgeEvent('permission_decision', ...)`

## Key Design Decisions

### 1. Hook-based Architecture
Extracted ~800 lines of window callbacks into `useWindowCallbacks` for:
- Separation of concerns
- Testability
- Reduced cognitive load in App.tsx

### 2. Ref-based Provider Tracking
```typescript
const currentProviderRef = useRef(currentProvider);
useEffect(() => {
  currentProviderRef.current = currentProvider;
}, [currentProvider]);
```
Avoids stale closures in window callbacks.

### 3. Streaming Message Index Tracking
Uses `streamingMessageIndexRef` instead of `isStreaming` flag to avoid race conditions with `updateMessages` overwrites.

### 4. Throttled Streaming Updates
Content updates are throttled at `THROTTLE_INTERVAL` (50ms) to balance responsiveness and performance.

### 5. Merged Messages for Display
```typescript
const mergedMessages = useMemo(() => {
  const visible = messages.filter(shouldShowMessage);
  return mergeConsecutiveAssistantMessages(visible, normalizeBlocks);
}, [messages, shouldShowMessage, normalizeBlocks]);
```
Consecutive assistant messages are merged for consistent styling.

## File Dependencies

```
App.tsx
├── hooks/
│   ├── useWindowCallbacks ──▶ useStreamingMessages (refs)
│   │                       ──▶ useDialogManagement (handlers)
│   ├── useRewindHandlers ───▶ mergedMessages (computed)
│   └── useSessionManagement ─▶ useDialogManagement (state)
├── utils/
│   ├── localizationUtils ───▶ i18next
│   └── messageUtils ────────▶ types
└── components/
    ├── ChatInputBox ────────▶ types, bridge
    └── MessageItem ─────────▶ ContentBlockRenderer
```

## Performance Considerations

1. **Memoized Utilities**: `getMessageText`, `normalizeBlocks`, `shouldShowMessage` are wrapped in `useCallback`
2. **Memoized Computed Values**: `mergedMessages`, `globalTodos`, `rewindableMessages` use `useMemo`
3. **Ref-based ChatInputBox**: Uses uncontrolled mode to avoid re-render loops
4. **Throttled Streaming**: Prevents excessive re-renders during streaming

## Future Improvements

1. Consider splitting `useWindowCallbacks` into smaller domain-specific hooks
2. Add error boundaries for view components
3. Consider React Query for history data fetching
4. Add unit tests for custom hooks

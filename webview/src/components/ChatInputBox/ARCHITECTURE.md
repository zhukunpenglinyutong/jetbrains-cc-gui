# ChatInputBox Implementation Guide

A comprehensive guide to the ChatInputBox component architecture and implementation principles.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Directory Structure](#directory-structure)
3. [Core Components](#core-components)
4. [Hooks Reference](#hooks-reference)
5. [Utilities Reference](#utilities-reference)
6. [Key Implementation Details](#key-implementation-details)
7. [Performance Optimizations](#performance-optimizations)

---

## Architecture Overview

The ChatInputBox is a rich text input component built with `contenteditable` div, supporting:

- **Auto height adjustment** - Expands with content
- **IME (Input Method Editor) handling** - Full support for CJK input
- **@ File references** - Autocomplete file paths with visual tags
- **/ Slash commands** - Command palette integration
- **# Agent selection** - AI agent switching
- **Paste/Drop support** - Images and file paths
- **Mac keyboard shortcuts** - Full cursor navigation support

### Design Principles

1. **Separation of Concerns** - Each hook handles a single responsibility
2. **Performance First** - Debouncing, caching, and minimal re-renders
3. **JCEF Compatibility** - Works in embedded browser environments
4. **Accessibility** - Keyboard navigation and proper focus management

---

## Directory Structure

```
ChatInputBox/
├── ChatInputBox.tsx          # Main component (orchestrator)
├── types.ts                  # TypeScript type definitions
├── styles.css                # Component styles
├── index.tsx                 # Barrel export
│
├── hooks/                    # Custom React hooks
│   ├── index.ts              # Hook exports
│   ├── useTextContent.ts     # Text extraction with cache
│   ├── useFileTags.ts        # File tag rendering
│   ├── useTooltip.ts         # Tooltip state management
│   ├── useKeyboardNavigation.ts  # Mac cursor shortcuts
│   ├── useIMEComposition.ts  # IME handling
│   ├── usePasteAndDrop.ts    # Clipboard/DnD operations
│   ├── usePromptEnhancer.ts  # AI prompt enhancement
│   ├── useGlobalCallbacks.ts # Java interop callbacks
│   ├── useCompletionDropdown.ts  # Dropdown state/logic
│   └── useTriggerDetection.ts    # @/# trigger detection
│
├── utils/                    # Utility functions
│   ├── index.ts              # Utils exports
│   ├── debounce.ts           # Debounce utility
│   ├── htmlEscape.ts         # HTML attribute escaping
│   └── generateId.ts         # UUID generation
│
├── providers/                # Data providers for dropdowns
│   ├── index.ts
│   ├── fileReferenceProvider.ts
│   ├── slashCommandProvider.ts
│   └── agentProvider.ts
│
├── selectors/                # Dropdown selector components
│   ├── ModeSelect.tsx
│   ├── ModelSelect.tsx
│   └── ...
│
├── Dropdown/                 # Dropdown components
│   ├── index.tsx
│   └── DropdownItem.tsx
│
└── [Other Components]        # ButtonArea, ContextBar, etc.
```

---

## Core Components

### ChatInputBox.tsx (Main Component)

The orchestrator component that:

1. **Initializes all hooks** and manages their coordination
2. **Renders the UI structure** (context bar, input area, button area, dropdowns)
3. **Handles controlled/uncontrolled modes** via `useImperativeHandle`
4. **Coordinates event handlers** between different subsystems

```typescript
// Key structure
const ChatInputBox = forwardRef<ChatInputBoxHandle, ChatInputBoxProps>((props, ref) => {
  // 1. State hooks
  const { getTextContent, invalidateCache } = useTextContent({ editableRef });
  const { renderFileTags, pathMappingRef } = useFileTags({ ... });
  const { tooltip, handleMouseOver } = useTooltip();
  // ... more hooks

  // 2. Completion hooks (file, command, agent)
  const fileCompletion = useCompletionDropdown<FileItem>({ ... });
  const commandCompletion = useCompletionDropdown<CommandItem>({ ... });
  const agentCompletion = useCompletionDropdown<AgentItem>({ ... });

  // 3. Event handlers
  const handleInput = useCallback(...);
  const handleKeyDown = useCallback(...);
  const handleSubmit = useCallback(...);

  // 4. Imperative API
  useImperativeHandle(ref, () => ({
    getValue, setValue, focus, clear, hasContent
  }));

  // 5. Render
  return (
    <div className="chat-input-box">
      <ContextBar ... />
      <div className="input-editable-wrapper">
        <div ref={editableRef} contentEditable ... />
      </div>
      <ButtonArea ... />
      <CompletionDropdown ... />
    </div>
  );
});
```

---

## Hooks Reference

### useTextContent

**Purpose:** Extract plain text from contenteditable element with caching.

**Key Features:**
- **Cache optimization** - Avoids repeated DOM traversal
- **File tag handling** - Converts file tag elements back to `@path` format
- **Newline normalization** - Handles JCEF-specific trailing newlines

```typescript
const { getTextContent, invalidateCache } = useTextContent({ editableRef });
```

### useFileTags

**Purpose:** Render `@filepath` text as visual file tag elements.

**Key Features:**
- **Path validation** - Only renders tags for paths in pathMappingRef
- **Icon rendering** - Shows file/folder icons based on extension
- **Tooltip support** - Stores full path for hover display

```typescript
const { renderFileTags, pathMappingRef, justRenderedTagRef } = useFileTags({
  editableRef,
  getTextContent,
  onCloseCompletions,
});
```

### useTooltip

**Purpose:** Manage tooltip state for file tags.

**Key Features:**
- **Smart positioning** - Avoids viewport overflow
- **Dynamic arrow placement** - Points to element center

```typescript
const { tooltip, handleMouseOver, handleMouseLeave } = useTooltip();
```

### useKeyboardNavigation

**Purpose:** Handle Mac-style keyboard shortcuts.

**Supported Shortcuts:**
- `Cmd + Left/Right` - Move to line start/end
- `Cmd + Up/Down` - Move to text start/end
- `Cmd + Backspace` - Delete to line start
- `Shift` variants - Text selection

```typescript
const { handleMacCursorMovement } = useKeyboardNavigation({
  editableRef,
  handleInput,
});
```

### useIMEComposition

**Purpose:** Handle IME (Input Method Editor) composition events.

**Key Features:**
- **Dual state tracking** - Uses both React state and ref for sync access
- **Composition protection** - Prevents operations during IME input
- **Post-composition sync** - Updates state after composition ends

```typescript
const {
  isComposing,
  isComposingRef,
  lastCompositionEndTimeRef,
  handleCompositionStart,
  handleCompositionEnd,
} = useIMEComposition({ handleInput, renderFileTags });
```

### usePasteAndDrop

**Purpose:** Handle clipboard paste and drag-drop operations.

**Supported Operations:**
- **Image paste/drop** - Converts to Base64 attachments
- **Text paste** - Inserts at cursor position
- **File path drop** - Auto-creates file references

```typescript
const { handlePaste, handleDragOver, handleDrop } = usePasteAndDrop({
  editableRef,
  pathMappingRef,
  getTextContent,
  // ... more options
});
```

### usePromptEnhancer

**Purpose:** AI-powered prompt enhancement feature.

**Flow:**
1. User triggers enhancement (⌘/)
2. Opens dialog with original prompt
3. Sends to backend via `window.sendToJava`
4. Receives enhanced prompt via `window.updateEnhancedPrompt`
5. User can accept or keep original

```typescript
const {
  isEnhancing,
  showEnhancerDialog,
  originalPrompt,
  enhancedPrompt,
  handleEnhancePrompt,
  handleUseEnhancedPrompt,
  handleKeepOriginalPrompt,
  handleCloseEnhancerDialog,
} = usePromptEnhancer({ editableRef, getTextContent, selectedModel, ... });
```

### useGlobalCallbacks

**Purpose:** Register global functions for Java interop.

**Registered Functions:**
- `window.handleFilePathFromJava(path)` - Insert file path from IDE
- `window.insertCodeSnippetAtCursor(snippet)` - Insert code selection

```typescript
useGlobalCallbacks({
  editableRef,
  pathMappingRef,
  getTextContent,
  // ... more options
});
```

### useCompletionDropdown

**Purpose:** Unified completion dropdown logic.

**Features:**
- **Debounced search** - Reduces API calls
- **Race condition protection** - Uses AbortController
- **Keyboard navigation** - Arrow keys, Enter, Escape
- **Mouse navigation** - Hover selection

```typescript
const completion = useCompletionDropdown<ItemType>({
  trigger: '@',
  provider: dataProvider,
  toDropdownItem: itemConverter,
  onSelect: handleSelection,
  debounceMs: 200,
});
```

### useTriggerDetection

**Purpose:** Detect @, /, # triggers in text.

**Features:**
- **Position-aware detection** - Only triggers at valid positions
- **File tag awareness** - Skips triggers inside file tags
- **Cursor position tracking** - Uses Selection API

```typescript
const { detectTrigger, getTriggerPosition, getCursorPosition } = useTriggerDetection();
```

---

## Utilities Reference

### debounce

Delays function execution until after wait milliseconds.

```typescript
const debouncedFn = debounce(fn, 200);
```

### escapeHtmlAttr

Escapes special characters for HTML attributes.

```typescript
const safe = escapeHtmlAttr('path/with"quotes');
// Returns: path/with&quot;quotes
```

### generateId

Generates unique IDs, JCEF compatible.

```typescript
const id = generateId();
// Returns: UUID or timestamp-based fallback
```

---

## Key Implementation Details

### Text Content Extraction

The input uses `contenteditable` with complex content (text + file tag elements). Text extraction must:

1. **Walk the DOM tree** recursively
2. **Handle file tags** by reading `data-file-path` attribute
3. **Preserve newlines** from `<br>` and block elements
4. **Skip tag children** to avoid duplicate text

### File Tag Rendering

File tags are rendered when:

1. User types `@path ` (space triggers rendering)
2. User selects from dropdown (immediate rendering)
3. Drag-drop file path (immediate rendering)

Validation ensures only "valid" paths (from dropdown selection) become tags.

### IME Handling

IME handling is critical for CJK input. The implementation:

1. **Tracks composition state** via both ref (sync) and state (async)
2. **Skips all DOM operations** during composition
3. **Uses `keyCode === 229`** to detect IME processing early
4. **Prevents false Enter triggers** by checking `lastCompositionEndTimeRef`

### Send Key Detection

Supports two modes:

- **Enter mode**: Enter sends, Shift+Enter newlines
- **Cmd+Enter mode**: Cmd/Ctrl+Enter sends, Enter newlines

Detection uses multiple methods for JCEF compatibility:
- `e.key === 'Enter'`
- `e.keyCode === 13`
- `e.nativeEvent.isComposing` check

---

## Performance Optimizations

### 1. Text Content Caching

```typescript
// Cache invalidated only when innerHTML length changes
if (currentHtmlLength === cache.htmlLength && cache.content !== '') {
  return cache.content;
}
```

### 2. Debounced Callbacks

```typescript
// Reduce parent re-renders during rapid typing
const debouncedOnInput = useMemo(
  () => debounce((text) => onInput?.(text), 100),
  [onInput]
);
```

### 3. Uncontrolled Mode

```typescript
// Parent uses imperative API instead of controlled value
useImperativeHandle(ref, () => ({
  getValue: () => getTextContent(),
  setValue: (value) => { /* direct DOM update */ },
  // ...
}));
```

### 4. Completion Detection Optimization

```typescript
// Quick check before expensive detection
const hasAtSymbol = text.includes('@');
if (!hasAtSymbol && !hasSlashSymbol && !hasHashSymbol) {
  return; // Skip detection
}
```

### 5. Request Cancellation

```typescript
// Cancel previous request on new input
if (abortControllerRef.current) {
  abortControllerRef.current.abort();
}
const controller = new AbortController();
```

---

## Extending the Component

### Adding a New Trigger

1. Create a provider in `providers/`
2. Add a `useCompletionDropdown` instance
3. Update `detectAndTriggerCompletion` to handle new trigger
4. Add a `<CompletionDropdown>` in the render

### Adding a New Hook

1. Create hook file in `hooks/`
2. Export from `hooks/index.ts`
3. Use in `ChatInputBox.tsx`
4. Document in this file

---

## Troubleshooting

### IME Issues

- Ensure `isComposingRef.current` is checked in native event handlers
- Check `lastCompositionEndTimeRef` for false Enter triggers
- Use `requestAnimationFrame` for post-composition cleanup

### File Tag Not Rendering

- Check if path is in `pathMappingRef`
- Ensure space is typed after path (triggers `debouncedRenderFileTags`)
- Check `justRenderedTagRef` isn't blocking detection

### Dropdown Not Appearing

- Check trigger detection is finding valid position
- Ensure completion isn't closed by `justRenderedTagRef`
- Verify provider is returning results

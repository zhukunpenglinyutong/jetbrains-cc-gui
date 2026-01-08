# Rewind Feature Design

## Overview

This document describes the design of the file rewind feature, which allows users to restore files to their state at a previous message point using the Claude Agent SDK's `rewindFiles()` API.

## Feature Scope

### What This Feature Does
- Restore modified files to their state at a specific user message
- Provide clear visual feedback about the impact of rewinding
- Ensure safe operation with confirmation dialogs

### What This Feature Does NOT Do
- Does not rewind conversation history (only files)
- Does not support partial file restoration
- Does not provide undo for rewind operations

## SDK Requirements

### Required SDK Version
- `@anthropic-ai/claude-agent-sdk`: ^0.1.76 or higher

### Required Configuration
```javascript
const options = {
  enableFileCheckpointing: true,  // Must be enabled
  // ... other options
};
```

### Core API
```typescript
// Rewind files to a specific user message
await result.rewindFiles(userMessageId: string): Promise<void>;
```

## User Interface Design

### 1. Rewind Button Placement

The rewind button appears next to each **user message** in the conversation history.

**Visual Layout:**
```
┌─────────────────────────────────────┐
│  [20:30] User: "Add login feature"   │ [⟲] ← Rewind button
│  [20:30] Assistant: "I'll add..."    │
│  Modified: auth.js, login.js         │
├─────────────────────────────────────┤
│  [20:25] User: "Fix bug in utils"    │ [⟲]
│  [20:25] Assistant: "Fixed..."       │
│  Modified: utils.js                  │
└─────────────────────────────────────┘
```

**Button States:**
- **Default**: Semi-transparent, visible on hover
- **Current message**: No rewind button (cannot rewind to current state)
- **First message**: Rewind button available (rewind to initial state)
- **Disabled**: When file checkpointing is not enabled

### 2. Confirmation Dialog

When the user clicks the rewind button, a confirmation dialog appears with detailed impact information.

**Dialog Layout:**
```
┌─────────────────────────────────────────────┐
│  ⚠️ Rewind Files to Previous State           │
├─────────────────────────────────────────────┤
│  Rewind to:                                  │
│  📝 [20:25] "Fix bug in utils"               │
│                                              │
│  ⚠️ Impact:                                  │
│  • Will restore 2 files to their state       │
│    at this message                           │
│  • Changes made after this point will be     │
│    lost (3 messages affected)                │
│  • Conversation history will be kept         │
│                                              │
│  📁 Files to be restored:                    │
│  • auth.js (modified 2 times after)          │
│  • login.js (modified 1 time after)          │
│                                              │
│  [Show file changes ▼]  ← Expandable         │
│                                              │
│  ○ Restore code                              │
│  ○ Never mind                                │
│                                              │
│  [Cancel]              [Restore Files]       │
└─────────────────────────────────────────────┘
```

**Dialog Components:**

1. **Header**: Clear warning icon and title
2. **Target Message**: Shows which message point will be restored
3. **Impact Warning**:
   - Number of files to be restored
   - Number of messages affected
   - Clarification that conversation history is preserved
4. **File List**: Shows which files will be restored and how many times they were modified
5. **Expandable Details**: Optional detailed file changes preview
6. **Action Options**:
   - Restore code (primary action)
   - Never mind (cancel)
7. **Action Buttons**: Cancel and Restore Files

### 3. Expandable File Changes Preview (Optional)

When the user clicks "Show file changes", the dialog expands to show detailed file information.

**Expanded View:**
```
┌─────────────────────────────────────────────┐
│  📁 File Changes Preview                     │
├─────────────────────────────────────────────┤
│  auth.js                                     │
│  Current: 156 lines                          │
│  After rewind: 142 lines (-14 lines)         │
│  [View diff]                                 │
│                                              │
│  login.js                                    │
│  Current: 89 lines                           │
│  After rewind: 85 lines (-4 lines)           │
│  [View diff]                                 │
└─────────────────────────────────────────────┘
```

**Features:**
- Shows line count changes for each file
- Provides "View diff" button to open file comparison
- Helps users understand the scope of changes

### 4. Success Feedback

After successful rewind operation, show a success notification.

**Success Dialog:**
```
┌─────────────────────────────────────────────┐
│  ✅ Files Restored Successfully              │
├─────────────────────────────────────────────┤
│  Restored 2 files to state at:               │
│  📝 [20:25] "Fix bug in utils"               │
│                                              │
│  • auth.js ✓                                 │
│  • login.js ✓                                │
│                                              │
│  [View restored files]  [OK]                 │
└─────────────────────────────────────────────┘
```

**Features:**
- Clear success indicator
- Shows which files were restored
- Provides option to view the restored files
- Auto-dismiss after 5 seconds (or manual dismiss)

### 5. Error Feedback

If the rewind operation fails, show an error dialog with helpful information.

**Error Dialog:**
```
┌─────────────────────────────────────────────┐
│  ❌ Failed to Restore Files                  │
├─────────────────────────────────────────────┤
│  Error: Session has ended                    │
│                                              │
│  Possible reasons:                           │
│  • The session is no longer active           │
│  • File checkpointing was not enabled        │
│  • The message ID is invalid                 │
│                                              │
│  [View details]  [OK]                        │
└─────────────────────────────────────────────┘
```

**Common Error Scenarios:**
1. **Session ended**: The query result object is no longer available
2. **Checkpointing disabled**: File checkpointing was not enabled in options
3. **Invalid message ID**: The specified message ID doesn't exist
4. **File conflicts**: Files have been modified outside the session

## Incident Summary (2026-01) — “No file checkpoint found”

### Symptom

Users click the rewind button (“回溯”) and the operation fails with:

- `No file checkpoint found for message <uuid>`

In the IDE log this typically appears after the rewind command is started and the session is resumed successfully, but `rewindFiles()` still throws.

### Why This Happened

This issue was caused by a mismatch between **which “user message uuid” the UI sends** and **which “user message uuid” the SDK uses to record file checkpoints**.

Concretely, our message stream contains multiple kinds of `type: "user"` entries:

1. **User text message** (the actual user prompt) — this is the one the SDK associates checkpoints with when `enableFileCheckpointing: true`.
2. **Tool result message** (a synthetic “user” message that only contains `tool_result`) — this is produced while the agent is executing tools and is **not** a valid rewind target for checkpoints.

When the UI passes the uuid of a tool-result-only “user” message into `result.rewindFiles(uuid)`, the SDK can’t find a checkpoint labeled by that uuid and throws `No file checkpoint found`.

There is also an operational detail that makes this more visible:

- The rewind operation runs in a fresh Node process. The in-memory `activeQueryResults` map is therefore empty during rewind, so we often have to `resume` the session. Resuming is fine, but it does not fix a wrong target uuid.

### Fix (What We Changed)

We implemented two layers of protection to ensure we always rewind using a valid target uuid.

#### 1) Frontend: don’t rewind from tool_result-only user messages

In the webview UI we detect “tool_result-only user messages” and:

- Hide/disable the rewind button on those messages.
- If a rewind is triggered from such a message (edge case), automatically walk upwards to find the nearest previous **real user text message**, and use that message’s uuid.

Code: [App.tsx](file:///Users/zhukunpeng/Desktop/idea-claude-code-gui/webview/src/App.tsx)

#### 2) Backend (ai-bridge): fallback to a better user message uuid when SDK says no checkpoint

In the Node bridge, if `result.rewindFiles(userMessageId)` throws the specific error:

- `No file checkpoint found for message ...`

we then:

1. Read the local session JSONL file from Claude’s projects history:
   - `~/.claude/projects/<sanitizedCwd>/<sessionId>.jsonl`
2. Build candidate uuids by following `parentUuid` links and preferring the nearest **user text message**.
3. Retry `rewindFiles()` with these candidate uuids until success or candidates are exhausted.

Code: [message-service.js](file:///Users/zhukunpeng/Desktop/idea-claude-code-gui/ai-bridge/services/claude/message-service.js)

### How To Prevent This From Happening Again

Use this checklist when touching rewind-related code:

1. **Always enable checkpointing**
   - Ensure `enableFileCheckpointing: true` is set for normal chat sessions and for resumed sessions.
2. **Only pass SDK-valid user message uuids**
   - The target must be the uuid of a **user text** message, not a tool-result-only message.
   - Any UI that shows rewind on “user messages” must exclude `tool_result`-only entries.
3. **Treat in-memory session maps as best-effort**
   - Rewind may execute in a separate process. Do not rely solely on in-memory `Map` state for correctness.
4. **Keep Claude project history readable**
   - The backend fallback relies on `~/.claude/projects/.../*.jsonl`. If the file is missing, moved, or unreadable, only the primary uuid path is available.

### Quick Debugging Tips

If the error happens again, check these in the IDE log:

- Does rewind log show `Active sessions in memory: []`? This means the bridge had to resume the session.
- Which `userMessageId` was sent from the frontend?
- Does the corresponding session JSONL contain that uuid as a user text message?

If not, the uuid is likely from a `tool_result` message, and the UI filtering/mapping should be revisited.

## Data Structures

### Frontend Message Tracking

To support the rewind feature, the frontend needs to track message metadata:

```typescript
interface MessageWithFiles {
  messageId: string;        // Message UUID from SDK
  timestamp: number;        // Message timestamp
  content: string;          // Message content (for display)
  type: 'user' | 'assistant';
  modifiedFiles: string[];  // List of files modified in this turn
  fileSnapshots?: {         // Optional: file state information
    [filePath: string]: {
      size: number;
      lines: number;
      lastModified: number;
    }
  }
}
```

### Session State Management

Track active query sessions for rewind operations:

```typescript
interface SessionState {
  sessionId: string;
  queryResult: any;         // The query result object from SDK
  messages: MessageWithFiles[];
  isCheckpointingEnabled: boolean;
}

// Global session storage
const activeSessions = new Map<string, SessionState>();
```

## Implementation Guidelines

### 1. When to Show Rewind Button

**Show rewind button when:**
- ✅ Message is a user message
- ✅ Message has associated file modifications
- ✅ File checkpointing is enabled for the session
- ✅ Message is not the most recent message

**Hide rewind button when:**
- ❌ Message is an assistant message
- ❌ Message has no file modifications
- ❌ File checkpointing is not enabled
- ❌ Message is the current/latest message
- ❌ Session has ended

### 2. Calculating Impact Range

To show accurate impact information in the confirmation dialog:

```typescript
function calculateRewindImpact(targetMessageId: string, messages: MessageWithFiles[]) {
  const targetIndex = messages.findIndex(m => m.messageId === targetMessageId);
  if (targetIndex === -1) return null;

  // Messages affected (after target message)
  const affectedMessages = messages.slice(targetIndex + 1);

  // Files modified after target message
  const modifiedFiles = new Map<string, number>();
  affectedMessages.forEach(msg => {
    msg.modifiedFiles.forEach(file => {
      modifiedFiles.set(file, (modifiedFiles.get(file) || 0) + 1);
    });
  });

  return {
    messageCount: affectedMessages.length,
    files: Array.from(modifiedFiles.entries()).map(([path, count]) => ({
      path,
      modificationCount: count
    }))
  };
}
```

### 3. Backend API Implementation

**Node.js Service (ai-bridge):**

```javascript
// Store active query results
const activeQueries = new Map();

export async function sendMessage(message, resumeSessionId = null, ...) {
  // Enable file checkpointing in options
  const options = {
    cwd: workingDirectory,
    permissionMode: effectivePermissionMode,
    model: sdkModelName,
    maxTurns: 100,
    enableFileCheckpointing: true,  // ✅ Enable checkpointing
    // ... other options
  };

  const result = query({ prompt: message, options });

  // Store result object for rewind operations
  if (currentSessionId) {
    activeQueries.set(currentSessionId, result);
  }

  // ... message loop
}

/**
 * Rewind files to a specific message state
 * @param {string} sessionId - Session ID
 * @param {string} userMessageId - User message UUID to rewind to
 */
export async function rewindFiles(sessionId, userMessageId) {
  try {
    const result = activeQueries.get(sessionId);
    if (!result) {
      throw new Error(`Session ${sessionId} not found or already ended`);
    }

    console.log(`[REWIND] Rewinding to message: ${userMessageId}`);
    await result.rewindFiles(userMessageId);
    console.log('[REWIND] Files rewound successfully');

    return { success: true };
  } catch (error) {
    console.error('[REWIND_ERROR]', error.message);
    return { success: false, error: error.message };
  }
}
```

### 4. Error Handling Strategy

**Error Categories:**

1. **Session Not Found**
   - Cause: Session has ended or query result was cleaned up
   - User Message: "This session is no longer active. Rewind is not available."
   - Action: Disable rewind buttons for this session

2. **Checkpointing Not Enabled**
   - Cause: `enableFileCheckpointing` was not set to true
   - User Message: "File checkpointing is not enabled for this session."
   - Action: Don't show rewind buttons

3. **Invalid Message ID**
   - Cause: Message ID doesn't exist in SDK's checkpoint history
   - User Message: "Cannot rewind to this message. It may be too old."
   - Action: Show error dialog with retry option

4. **File System Errors**
   - Cause: File conflicts, permission issues, disk full
   - User Message: "Failed to restore files: [specific error]"
   - Action: Show error dialog with details and support link

## Best Practices and Considerations

### 1. Performance Considerations

- **Checkpoint Storage**: File checkpointing uses disk space. Monitor usage for long sessions.
- **Message Tracking**: Keep message metadata in memory, but consider pagination for very long conversations.
- **UI Responsiveness**: Show loading indicator during rewind operation (may take a few seconds for large files).

### 2. User Experience Guidelines

- **Clear Communication**: Always explain what will happen before rewind
- **Confirmation Required**: Never rewind without explicit user confirmation
- **Visual Feedback**: Show clear success/error messages after operation
- **Undo Warning**: Inform users that rewind cannot be undone

### 3. Edge Cases

- **Session Resume**: When resuming a session, check if checkpointing is enabled
- **Multiple Windows**: If user has multiple IDE windows, coordinate rewind state
- **External File Changes**: Warn if files were modified outside the session
- **First Message**: Rewinding to first message restores initial state

## Summary

This rewind feature provides users with a safe way to restore files to previous states during a Claude Code session. Key points:

✅ **Simple UI**: Single rewind button per user message
✅ **Clear Feedback**: Detailed impact information before confirmation
✅ **Safe Operation**: Requires explicit confirmation with clear warnings
✅ **Error Handling**: Comprehensive error messages and recovery options
✅ **SDK Integration**: Uses official `rewindFiles()` API with checkpointing

## Implementation Phases

### Phase 1: Backend API (ai-bridge)
- Add `enableFileCheckpointing: true` to query options
- Implement `rewindFiles()` function
- Store active query results in Map
- Add error handling and logging

### Phase 2: Frontend UI (IntelliJ Plugin)
- Add rewind button component to message UI
- Implement confirmation dialog
- Add success/error notification system

### Phase 3: Message Tracking
- Track message metadata (ID, timestamp, modified files)
- Implement impact calculation logic
- Store session state

### Phase 4: Polish and Testing
- Add loading indicators
- Implement expandable file details
- Test error scenarios
- User acceptance testing

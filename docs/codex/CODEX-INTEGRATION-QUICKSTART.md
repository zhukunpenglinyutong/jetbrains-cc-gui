# Codex Integration Quickstart

> 迁移说明：本文只保留历史 SDK 接入背景。当前正常 Codex 发送使用 Java → Node daemon → `codex app-server --listen stdio://`；Codex 在 CLI 识别页面管理，旧 `codex-sdk` 目录只作既有 CLI 的只读兼容查找，不应重新引入每轮 SDK 实例化。旧示例中的 `skipGitRepoCheck`、`maxTurns`、布尔权限 IPC 和执行后回滚不属于当前运行时。请以 [app-server 迁移基准](app-server.md) 为运行时合同。

> **✨ Done with Geek Spirit** — Following Steve Jobs' pursuit of simplicity and elegance

## 🎉 What's New

Codex app-server has been integrated with the same provider-neutral session facade as Claude.

## 🏗️ Architecture Highlights

### Symmetrical Design

```
Claude:  Java → ClaudeSDKBridge → ai-bridge → @anthropic-ai/claude-agent-sdk
Codex:   Java → CodexSDKBridge  → ai-bridge → codex app-server (stdio)
Gemini:  Java → GeminiSDKBridge → ai-bridge → (future)
         ↑ Perfect symmetry - easy to maintain
```

### Key Features

- ✅ **Native approval policy**: Codex asks when its policy requires escalation
- ✅ **Automatic Mapping**: sessionId ↔ native threadId translation happens automatically
- ✅ **Streaming Support**: Real-time responses for both Claude and Codex
- ✅ **Modular Design**: Adding Gemini will take < 1 hour

## 📦 What Was Changed

### Files Created/Modified

```
ai-bridge/
├── services/codex/persistent-codex-service.js [NEW] App-server session FIFO
├── services/codex/codex-appserver-client.js   [NEW] Stdio JSON-RPC transport
├── channel-manager.js                   [UPDATED] Enabled Codex routing
└── package.json                         [UPDATED] No Codex SDK dependency

src/main/java/.../CodexSDKBridge.java   [UPDATED] Unified parameter mapping

docs/
├── MULTI-PROVIDER-ARCHITECTURE.md      [NEW] Complete architecture guide
└── CODEX-INTEGRATION-QUICKSTART.md     [NEW] This file
```

### Runtime dependency

```text
The SDK manager no longer manages Codex; the CLI detection page shows the
installed CLI. The old `codex-sdk` directory remains a read-only fallback.
The runtime resolves the external/legacy Codex
CLI and starts `codex app-server --listen stdio://`; it does not instantiate
the TypeScript SDK for normal turns.
```

## 🚀 How It Works

### Permission Mapping Example

```javascript
// User selects a native approval preset in IDEA
Java: permissionMode = "auto"
  ↓
Codex app-server settings:
  - approvalPolicy: "on-request"
  - sandboxPolicy: { type: "workspaceWrite" }
  ↓
Native policy decides whether a reverse approval request is needed.
```

### Session Management Example

```java
// Java layer (provider-agnostic)
sendMessage(channelId, message, conversationId, ...)

// Node.js layer (provider-specific)
Claude: receives as 'sessionId'
Codex:  receives as 'threadId'

// Magic: channel-manager.js handles the mapping automatically
```

## 🔧 Configuration

### API Key Setup

**Option 1: Plugin Settings (Recommended)**
```
IDEA → Settings → Codex API Key: sk-...
               → Base URL: https://api.openai.com (optional)
```

**Option 2: Code Configuration**
```java
CodexSDKBridge bridge = new CodexSDKBridge();
bridge.setApiKey("sk-...");
bridge.setBaseUrl("https://custom-endpoint.com"); // Optional
```

### Permission Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `request` | Ask when native policy requires escalation | Normal development |
| `sandboxed-auto` | Native reviewer may approve within workspace limits | Repetitive workspace tasks |
| `full-access` | Explicit danger-full-access scope | Trusted environments |

## 🧪 Testing

### Quick Test (Node.js)

```bash
cd ai-bridge

# Test the native app-server service with the repository peer (no account).
node --test services/codex/*.test.js services/codex/testing/*.test.js
```

### Integration Test (Java + Node.js)

```java
CodexSDKBridge bridge = new CodexSDKBridge();
// The bridge delegates to the per-chat persistent app-server service.
CompletableFuture<SDKResult> future = bridge.sendMessage(
    "channel-1", "Explain this codebase structure", null,
    "/path/to/project", null, "request", "gpt-5.6-sol",
    null, "medium", "default", callback, "client-message-id");
```

## 📊 Capability Comparison

| Feature | Claude | Codex | Notes |
|---------|--------|-------|-------|
| Streaming | ✅ | ✅ | Real-time responses |
| Session Resume | ✅ | ✅ | Continue conversations |
| Attachments | ✅ | ✅ | Codex sends native localImage items |
| Permission Control | ✅ | ✅ | Codex uses native approval/sandbox settings |
| Custom Models | ✅ | ✅ | Model selection supported |
| IDE Context | ✅ | ⚠️ | openedFiles (Claude only) |

## 🎯 Next Steps

1. **Configure API Key**: Set your OpenAI API key in plugin settings
2. **Select Provider**: Choose "Codex" from provider dropdown in UI
3. **Start Chatting**: Send a message - streaming should work immediately
4. **Try Permissions**: Test request, sandboxed-auto, and explicit full-access scopes

## 🐛 Troubleshooting

### "Codex support is temporarily disabled"

**Cause**: The managed Codex CLI or configured external CLI is not available
**Fix**:
```bash
Install the official Codex CLI externally, then re-check Settings → Provider Management → CLI.
```

### "API key not found"

**Cause**: No API key configured
**Fix**: Set API key in plugin settings or via `bridge.setApiKey(...)`

### "Permission denied"

**Cause**: Native approval policy or sandbox constraints rejected the request
**Fix**: Inspect the native approval dialog and effective sandbox source in Settings.

### Thread ID not captured

**Cause**: Event parsing issue
**Fix**: Verify `[THREAD_ID]` is being emitted in console logs

## 📚 Advanced Usage

### Resume a Codex Thread

```java
// First message (creates thread)
SDKResult result1 = bridge.sendMessage(..., null, ...).get();
String threadId = extractThreadId(result1); // From session_id callback

// Continue conversation
SDKResult result2 = bridge.sendMessage(..., threadId, ...).get();
```

### Native sandbox mode

Choose `read-only`, `workspace-write`, or `danger-full-access` through the
Codex access-scope setting. The app-server receives the corresponding native
`sandboxPolicy`; no `skipGitRepoCheck` or hand-written prompt wrapper is used.

## 🎨 Code Patterns

### Error Handling

```java
future.exceptionally(ex -> {
    SDKResult errorResult = new SDKResult();
    errorResult.success = false;
    errorResult.error = ex.getMessage();
    return errorResult;
});
```

### Cancellation

```java
String channelId = "my-channel";
// ... start operation ...

// Cancel if needed
bridge.interruptChannel(channelId);
```

## 📈 Performance Notes

- **Startup Time**: the Node daemon keeps one app-server child per chat host
- **Streaming**: First token typically arrives in ~500-1000ms
- **Memory**: Each active channel uses ~50-100MB of RAM

## 🔮 Future Enhancements

1. **Gemini Integration**: Following same pattern (< 1 hour work)
2. **Provider Fallback**: Auto-switch if primary provider fails
3. **Response Caching**: Cache identical queries
4. **Multi-Provider Comparison**: Send same query to multiple providers

## 💡 Design Philosophy

This integration follows these principles:

1. **"Simple is better than complex"** - The app-server transport owns native policy
2. **"Explicit is better than implicit"** - threadId vs sessionId is clearly documented
3. **"Practicality beats purity"** - We map different models to common interface
4. **"Readability counts"** - Code structure mirrors mental model

## 🙏 Acknowledgments

Built with inspiration from:
- Steve Jobs' pursuit of simplicity
- Unix philosophy of composability
- Open source communities

---

**Questions?** Check `docs/MULTI-PROVIDER-ARCHITECTURE.md` for complete details.

**Contributions Welcome!** This architecture makes adding new providers trivial.

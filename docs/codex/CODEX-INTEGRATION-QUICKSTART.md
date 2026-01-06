# Codex Integration Quickstart

> **✨ Done with Geek Spirit** — Following Steve Jobs' pursuit of simplicity and elegance

## 🎉 What's New

Codex SDK (@openai/codex-sdk) has been integrated with the same elegant architecture as Claude.

## 🏗️ Architecture Highlights

### Symmetrical Design

```
Claude:  Java → ClaudeSDKBridge → ai-bridge → @anthropic-ai/claude-agent-sdk
Codex:   Java → CodexSDKBridge  → ai-bridge → @openai/codex-sdk
Gemini:  Java → GeminiSDKBridge → ai-bridge → (future)
         ↑ Perfect symmetry - easy to maintain
```

### Key Features

- ✅ **Unified Permission System**: `DEFAULT`, `SANDBOX`, `YOLO` work across all providers
- ✅ **Automatic Mapping**: sessionId ↔ threadId translation happens automatically
- ✅ **Streaming Support**: Real-time responses for both Claude and Codex
- ✅ **Modular Design**: Adding Gemini will take < 1 hour

## 📦 What Was Changed

### Files Created/Modified

```
ai-bridge/
├── utils/permission-mapper.js           [NEW] Permission translation layer
├── services/codex/message-service.js    [UPDATED] Codex SDK integration
├── channel-manager.js                   [UPDATED] Enabled Codex routing
└── package.json                         [UPDATED] Added @openai/codex-sdk

src/main/java/.../CodexSDKBridge.java   [UPDATED] Unified parameter mapping

docs/
├── MULTI-PROVIDER-ARCHITECTURE.md      [NEW] Complete architecture guide
└── CODEX-INTEGRATION-QUICKSTART.md     [NEW] This file
```

### Dependencies Added

```json
{
  "@openai/codex-sdk": "^0.77.0"  // ~40MB (worth it for complete functionality)
}
```

## 🚀 How It Works

### Permission Mapping Example

```javascript
// User selects "YOLO" mode in IDEA
Java: permissionMode = "yolo"
  ↓
ai-bridge/utils/permission-mapper.js:
  - Claude: "yolo" → permissionMode: 'yolo'
  - Codex:  "yolo" → {skipGitRepoCheck: true, sandbox: 'danger-full-access'}
  ↓
SDK: Operates with provider-specific configuration
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
| `DEFAULT` | Ask before dangerous operations | Normal development |
| `SANDBOX` | Read-only, no modifications | Code review, exploration |
| `YOLO` | Auto-approve everything | Automation, trusted environments |

## 🧪 Testing

### Quick Test (Node.js)

```bash
cd ai-bridge

# Test permission mapper
node -e "
import {PermissionMapperFactory} from './utils/permission-mapper.js';
console.log(PermissionMapperFactory.toProvider('codex', 'yolo'));
// → {skipGitRepoCheck: true, sandbox: 'danger-full-access'}
"

# Test Codex service (requires API key)
echo '{"message":"Hello","threadId":"","cwd":"","permissionMode":"default"}' | \
  CODEX_USE_STDIN=true node channel-manager.js codex send
```

### Integration Test (Java + Node.js)

```java
CodexSDKBridge bridge = new CodexSDKBridge();
bridge.setApiKey("sk-...");

CompletableFuture<SDKResult> future = bridge.sendMessage(
    "channel-1",
    "Explain this codebase structure",
    null, // threadId (new conversation)
    "/path/to/project",
    null, // attachments (Codex doesn't support)
    "default", // permission mode
    "gpt-5.1", // model
    new MessageCallback() {
        public void onMessage(String type, String content) {
            System.out.println(type + ": " + content);
        }
        public void onError(String error) {
            System.err.println("Error: " + error);
        }
        public void onComplete(SDKResult result) {
            System.out.println("Done: " + result.finalResult);
        }
    }
);
```

## 📊 Capability Comparison

| Feature | Claude | Codex | Notes |
|---------|--------|-------|-------|
| Streaming | ✅ | ✅ | Real-time responses |
| Session Resume | ✅ | ✅ | Continue conversations |
| Attachments | ✅ | ❌ | Images, files (Claude only) |
| Permission Control | ✅ | ✅ | Unified 3-mode system |
| Custom Models | ✅ | ✅ | Model selection supported |
| IDE Context | ✅ | ⚠️ | openedFiles (Claude only) |

## 🎯 Next Steps

1. **Configure API Key**: Set your OpenAI API key in plugin settings
2. **Select Provider**: Choose "Codex" from provider dropdown in UI
3. **Start Chatting**: Send a message - streaming should work immediately
4. **Try Permissions**: Test DEFAULT, SANDBOX, YOLO modes

## 🐛 Troubleshooting

### "Codex support is temporarily disabled"

**Cause**: `@openai/codex-sdk` not installed
**Fix**:
```bash
cd ai-bridge
npm install @openai/codex-sdk
```

### "API key not found"

**Cause**: No API key configured
**Fix**: Set API key in plugin settings or via `bridge.setApiKey(...)`

### "Permission denied"

**Cause**: Permission mode mismatch
**Fix**: Check `permission-mapper.js` configuration for your use case

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

### Custom Sandbox Mode

```javascript
// In permission-mapper.js, create custom mapping
case 'CUSTOM_MODE':
  return {
    skipGitRepoCheck: true,
    sandbox: 'workspace-write',
    additionalRestrictions: {...}
  };
```

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

- **Package Size**: `@openai/codex-sdk` adds ~40MB to plugin
- **Startup Time**: Node.js process spawns in ~100-200ms
- **Streaming**: First token typically arrives in ~500-1000ms
- **Memory**: Each active channel uses ~50-100MB of RAM

## 🔮 Future Enhancements

1. **Gemini Integration**: Following same pattern (< 1 hour work)
2. **Provider Fallback**: Auto-switch if primary provider fails
3. **Response Caching**: Cache identical queries
4. **Multi-Provider Comparison**: Send same query to multiple providers

## 💡 Design Philosophy

This integration follows these principles:

1. **"Simple is better than complex"** - Permission mapper is single-responsibility
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

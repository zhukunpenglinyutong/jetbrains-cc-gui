# Multi-Provider Architecture

> Codex 运行时更新：本文中的旧 `codex/message-service.js` SDK、`skipGitRepoCheck` 和布尔权限示例仅用于历史架构对照。生产 Codex turn 使用持久 app-server service；交互、plan、compact、review 和 diff 的当前合同见 [app-server 迁移基准](app-server.md)。

## Current Codex path

The supported Codex path is `Java CodexSDKBridge → Node daemon → persistent
CodexAppServerService → codex app-server --listen stdio://`. A chat host reuses
one initialized child and native thread; `codex.send`, `thread/compact/start`,
and `review/start` share the FIFO, while interaction replies and abort bypass it.
Approval decisions use the native response union and sandbox policy. The legacy
mapping diagrams below do not describe the production send path and must not be
copied into new code.

> **"Simplicity is the ultimate sophistication."** — Leonardo da Vinci
>
> **"Design is not just what it looks like and feels like. Design is how it works."** — Steve Jobs

## 🎯 Philosophy

This architecture embodies three core principles:

1. **Abstraction** - Hide provider-specific complexity behind unified interfaces
2. **Extensibility** - Adding new providers (Gemini, etc.) should be trivial
3. **Elegance** - Code should be self-documenting and beautiful

## 🏗️ Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Java Layer (IDEA Plugin)                      │
│                                                                        │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────┐│
│  │ ClaudeSDKBridge    │  │ CodexSDKBridge     │  │ Gemini (future)││
│  │                    │  │                    │  │                ││
│  │ - sessionId        │  │ - threadId         │  │                ││
│  │ - permissionMode   │  │ - skipGitRepoCheck │  │                ││
│  │ - attachments ✅   │  │ - attachments ❌   │  │                ││
│  └─────────┬──────────┘  └─────────┬──────────┘  └────────┬───────┘│
│            │                       │                        │        │
│            └───────────────────────┼────────────────────────┘        │
│                                    │                                 │
│                         ┌──────────▼───────────┐                    │
│                         │ Unified JSON Protocol │                    │
│                         │  - conversationId     │                    │
│                         │  - permissionMode     │                    │
│                         │  - message            │                    │
│                         └──────────┬────────────┘                    │
└────────────────────────────────────┼──────────────────────────────────┘
                                     │
                          ProcessBuilder + stdin/stdout
                                     │
┌────────────────────────────────────▼──────────────────────────────────┐
│                       Node.js Layer (ai-bridge)                        │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │              channel-manager.js (Router)                         ││
│  │    Route by provider: "claude" | "codex" | "gemini"            ││
│  └────────┬──────────────────────────┬────────────────────┬────────┘│
│           │                          │                    │         │
│  ┌────────▼────────────┐   ┌─────────▼──────────┐   ┌────▼──────┐ │
│  │ services/claude/    │   │ services/codex/    │   │ services/ │ │
│  │                     │   │                    │   │  gemini/  │ │
│  │ message-service.js  │   │ message-service.js │   │ (future)  │ │
│  │ session-service.js  │   │ (thread mgmt)      │   │           │ │
│  │ attachment-svc.js   │   │                    │   │           │ │
│  └─────────────────────┘   └────────────────────┘   └───────────┘ │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐│
│  │                  utils/permission-mapper.js                    ││
│  │   Unified Permission → Provider-Specific Permission            ││
│  │   - DEFAULT → Claude: 'default' / Codex: workspace-write       ││
│  │   - SANDBOX → Claude: 'sandbox'  / Codex: read-only            ││
│  │   - YOLO    → Claude: 'yolo'     / Codex: danger-full-access   ││
│  └───────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────┘
```

## 🔑 Key Design Decisions

### 1. Unified Permission Model

**Problem**: Different providers use different permission systems:
- Claude: Simple string modes (`'default'`, `'sandbox'`, `'yolo'`)
- Codex: Configuration object (`{skipGitRepoCheck: true, sandbox: 'workspace-write'}`)

**Solution**: Centralized permission mapper that translates bidirectionally.

```javascript
// Unified → Provider-Specific
const mapper = PermissionMapperFactory.getMapper('codex');
const config = mapper.toProvider('yolo');
// → {skipGitRepoCheck: true, sandbox: 'danger-full-access'}

// Provider-Specific → Unified
const unified = mapper.fromProvider({sandbox: 'read-only'});
// → 'sandbox'
```

### 2. Session ID Abstraction

**Problem**: Claude uses `sessionId`, Codex uses `threadId`.

**Solution**:
- Java layer: Generic parameter name (e.g., `conversationId`)
- Node.js layer: Each service uses provider-specific naming
- Automatic mapping in channel-manager.js

```java
// Java: Generic interface
sendMessage(String channelId, String conversationId, ...)

// Node.js services:
// - claude/message-service.js receives resumeSessionId
// - codex/message-service.js receives threadId
```

### 3. Event System Normalization

**Problem**: Different event formats:
- Claude: `{type: 'assistant', message: {...}}`
- Codex: `{type: 'item.completed', item: {type: 'agent_message', text: '...'}}`

**Solution**: Each service emits unified console output:
```javascript
// Both providers emit:
console.log('[MESSAGE_START]');
console.log('[CONTENT]', content);
console.log('[CONTENT_DELTA]', delta);
console.log('[MESSAGE_END]');
```

## 📦 File Structure

```
ai-bridge/├── channel-manager.js          # Router: dispatches to provider services
├── package.json                 # Dependencies: @anthropic-ai/claude-agent-sdk
│                                #             @openai/codex-sdk
├── services/
│   ├── claude/
│   │   ├── message-service.js   # Claude SDK integration
│   │   ├── session-service.js   # Session history management
│   │   └── attachment-service.js # Multimodal support
│   └── codex/
│       └── message-service.js   # Codex SDK integration
│
├── utils/
│   ├── permission-mapper.js     # Unified ↔ Provider permission translation
│   └── stdin-utils.js           # JSON stdin/stdout utilities
│
└── config/
    └── api-config.js            # API key/base URL configuration
```

## 🔄 Message Flow

### Sending a Message

```
1. User types message in IDEA
   ↓
2. Java layer: ClaudeSDKBridge or CodexSDKBridge
   - Constructs stdin JSON with message
   - Spawns Node.js process
   ↓
3. channel-manager.js receives stdin
   - Routes by provider: "claude" | "codex"
   ↓
4. Provider service (e.g., codex/message-service.js)
   - Maps permissions via PermissionMapper
   - Calls SDK (e.g., Codex.startThread())
   - Streams events back to Java via console.log
   ↓
5. Java layer reads stdout line by line
   - Parses [MESSAGE_START], [CONTENT_DELTA], [MESSAGE_END]
   - Invokes callback for UI updates
   ↓
6. User sees streaming response in IDEA
```

## 🚀 Adding a New Provider (e.g., Gemini)

### Step 1: Create Service Module

```bash
mkdir -p ai-bridge/services/gemini
touch ai-bridge/services/gemini/message-service.js
```

### Step 2: Implement Message Service

```javascript
// ai-bridge/services/gemini/message-service.js
import { GeminiClient } from '@google/generative-ai';
import { GeminiPermissionMapper } from '../../utils/permission-mapper.js';

export async function sendMessage(message, sessionId, cwd, permissionMode, model) {
  console.log('[MESSAGE_START]');

  // Map permissions
  const config = GeminiPermissionMapper.toProvider(permissionMode);

  // Call Gemini SDK
  const client = new GeminiClient(config);
  const response = await client.generateContent(message);

  // Emit unified events
  console.log('[CONTENT]', response.text);
  console.log('[MESSAGE_END]');
  console.log(JSON.stringify({success: true, sessionId}));
}
```

### Step 3: Add Permission Mapper

```javascript
// ai-bridge/utils/permission-mapper.js
export class GeminiPermissionMapper {
  static toProvider(unifiedMode) {
    switch (unifiedMode) {
      case UnifiedPermissionMode.DEFAULT:
        return {safetySettings: 'BLOCK_MEDIUM_AND_ABOVE'};
      case UnifiedPermissionMode.SANDBOX:
        return {safetySettings: 'BLOCK_ONLY_HIGH'};
      case UnifiedPermissionMode.YOLO:
        return {safetySettings: 'BLOCK_NONE'};
      default:
        return {safetySettings: 'BLOCK_MEDIUM_AND_ABOVE'};
    }
  }
}
```

### Step 4: Update Router

```javascript
// ai-bridge/channel-manager.js
import { sendMessage as geminiSendMessage } from './services/gemini/message-service.js';

async function handleGeminiCommand(command, args, stdinData) {
  switch (command) {
    case 'send':
      await geminiSendMessage(...stdinData);
      break;
  }
}

// In main execution
if (provider === 'gemini') {
  await handleGeminiCommand(command, args, stdinData);
}
```

### Step 5: Create Java Bridge

```java
// src/main/java/.../GeminiSDKBridge.java
public class GeminiSDKBridge {
    public CompletableFuture<SDKResult> sendMessage(...) {
        // Similar to CodexSDKBridge
        // Calls: node channel-manager.js gemini send
    }
}
```

**That's it!** The architecture handles the rest automatically.

## ⚙️ Configuration

### Permission Modes

| Unified Mode | Claude           | Codex                        | Gemini (Example)          |
|-------------|------------------|------------------------------|---------------------------|
| `DEFAULT`   | `'default'`      | `workspace-write`            | `BLOCK_MEDIUM_AND_ABOVE`  |
| `SANDBOX`   | `'sandbox'`      | `read-only`                  | `BLOCK_ONLY_HIGH`         |
| `YOLO`      | `'yolo'`         | `danger-full-access`         | `BLOCK_NONE`              |

### API Configuration

Each provider supports custom base URL and API key:

```javascript
// Passed via stdin JSON
{
  "message": "Hello",
  "permissionMode": "default",
  "baseUrl": "https://custom-api.example.com",  // Optional
  "apiKey": "sk-..."                             // Optional
}
```

## 🧪 Testing

### Test Claude Integration

```bash
cd ai-bridge
npm run test:claude
# Calls: node channel-manager.js claude send
```

### Test Codex Integration

```bash
cd ai-bridge
npm run test:codex
# Calls: node channel-manager.js codex send
```

### Manual Testing

```bash
# Test permission mapping
node -e "
import {PermissionMapperFactory} from './utils/permission-mapper.js';
const config = PermissionMapperFactory.toProvider('codex', 'yolo');
console.log(config);
// → {skipGitRepoCheck: true, sandbox: 'danger-full-access'}
"
```

## 📊 Provider Capability Matrix

| Feature | Claude | Codex | Gemini (Future) |
|---------|--------|-------|-----------------|
| Streaming | ✅ | ✅ | ✅ |
| Session Resume | ✅ (sessionId) | ✅ (threadId) | ✅ (sessionId) |
| Attachments | ✅ | ❌ | ✅ |
| Thinking Mode | ✅ | ❌ | ⚠️ |
| IDE Context | ✅ (openedFiles) | ⚠️ (manual) | ⚠️ (manual) |
| Tools/Functions | ✅ | ✅ | ✅ |
| Permission Control | ✅ | ✅ | ✅ |

**Legend**:
- ✅ Fully supported
- ⚠️ Partial/manual support
- ❌ Not supported

## 🔐 Security Considerations

1. **API Keys**: Never log raw API keys. Use masking in debug output.
2. **Process Isolation**: Each provider runs in isolated Node.js process.
3. **Permission Validation**: Java layer validates permissions before spawning processes.
4. **Stdin/Stdout**: Use JSON serialization to prevent command injection.

## 📈 Performance Optimization

- **Process Reuse**: Consider connection pooling for frequent operations
- **Stream Buffering**: Use `BufferedReader` for efficient stdout parsing
- **Timeout Management**: Each provider has configurable timeouts
- **Memory Management**: Clean up processes in `finally` blocks

## 🎨 Code Style Guidelines

1. **Java**: Follow existing `ClaudeSDKBridge` patterns
2. **JavaScript**: ESM modules, async/await, explicit error handling
3. **Comments**: Explain *why*, not *what*
4. **Naming**:
   - Java: `camelCase` for methods, `PascalCase` for classes
   - JavaScript: `camelCase` for functions, `PascalCase` for classes

## 🐛 Debugging Tips

### Enable Debug Logging

```java
// Java side
LOG.setLevel(Level.DEBUG);
```

```javascript
// Node.js side: Already using [DEBUG] prefix
console.log('[DEBUG] Your message here');
```

### Common Issues

**Issue**: "Provider not found"
- **Fix**: Check provider string matches exactly: `"claude"`, `"codex"`, `"gemini"`

**Issue**: "Permission denied"
- **Fix**: Verify `PermissionMapper` configuration for the provider

**Issue**: "Thread ID not captured"
- **Fix**: Ensure service emits `console.log('[THREAD_ID]', threadId);`

## 🎯 Future Enhancements

1. **Provider Plugins**: Load providers dynamically from npm packages
2. **WebSocket Support**: Real-time bidirectional communication
3. **Caching Layer**: Cache responses for identical queries
4. **Metrics Collection**: Track usage, latency, error rates per provider
5. **A/B Testing**: Route same query to multiple providers, compare results

## 📚 References

- [Claude Agent SDK Documentation](https://github.com/anthropics/claude-code/tree/main/sdk/typescript)
- [Codex SDK Documentation](https://github.com/openai/codex/tree/main/sdk/typescript)
- [IDEA Plugin Development Guide](https://plugins.jetbrains.com/docs/intellij/)

---

**Crafted with ❤️ and geek spirit**
*"Make it work, make it right, make it fast."* — Kent Beck

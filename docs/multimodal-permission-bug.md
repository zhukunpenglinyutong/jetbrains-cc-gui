# 多模态消息权限弹窗失效问题

## 问题描述

当用户发送包含图片的多模态消息时，Claude 在执行工具（如 Write、Bash）时不会弹出权限确认对话框，工具直接执行。而发送纯文本消息时权限弹窗正常工作。

### 表现形式

| 消息类型 | 权限弹窗 | 结果 |
|---------|---------|------|
| 纯文本消息 | ✅ 正常显示 | 用户可以确认或拒绝 |
| 图片+文本消息 | ❌ 不显示 | 工具直接执行，无需确认 |
| 先发图片，AI回复后再发纯文本 | ✅ 正常显示 | 用户可以确认或拒绝 |

## 根本原因

### Claude Agent SDK 的 `query()` 函数签名

```typescript
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query
```

`prompt` 参数有两种模式：
1. **字符串模式** (`string`)：直接传递文本消息
2. **流式模式** (`AsyncIterable<SDKUserMessage>`)：用于发送复杂的多模态消息

### 问题所在

**当使用 `AsyncIterable<SDKUserMessage>` 作为 `prompt` 时，SDK 的 `canUseTool` 回调不会被触发。**

这是 SDK 在流式输入模式下的一个行为特性（或 bug）。在这种模式下，`options.canUseTool` 虽然被设置，但 SDK 内部不会调用它。

### 代码对比

**纯文本消息（正常工作）：**
```javascript
const result = query({
  prompt: message,  // string 类型
  options: {
    canUseTool: canUseTool  // ✅ 会被调用
  }
});
```

**多模态消息（权限失效）：**
```javascript
const inputStream = new AsyncStream();
inputStream.enqueue(userMessage);  // SDKUserMessage 包含图片
inputStream.done();

const result = query({
  prompt: inputStream,  // AsyncIterable 类型
  options: {
    canUseTool: canUseTool  // ❌ 不会被调用
  }
});
```

## 解决方案

使用 **PreToolUse Hook** 替代 `canUseTool` 回调。

SDK 提供了 hooks 机制，其中 `PreToolUse` hook 会在工具执行前被调用，无论 `prompt` 是什么类型。

### 修复代码

```javascript
// PreToolUse hook 用于权限控制
const preToolUseHook = async (input, toolUseID, options) => {
  console.log('[HOOK] PreToolUse called:', input.tool_name);
  
  if (normalizedPermissionMode !== 'default') {
    return { decision: 'approve' };
  }
  
  // 调用原有的 canUseTool 进行权限检查
  const result = await canUseTool(input.tool_name, input.tool_input);
  
  if (result.behavior === 'allow') {
    return { decision: 'approve' };
  } else if (result.behavior === 'deny') {
    return { 
      decision: 'block',
      reason: result.message || 'Permission denied'
    };
  }
  return {};
};

const options = {
  // ... 其他配置
  hooks: {
    PreToolUse: [{
      hooks: [preToolUseHook]
    }]
  }
};
```

## 后续开发注意事项

### 1. 多模态消息必须使用 hooks

当需要发送包含图片的消息时，**不要依赖 `canUseTool`**，必须同时配置 `PreToolUse` hook：

```javascript
const options = {
  canUseTool: canUseTool,        // 可能不生效
  hooks: {
    PreToolUse: [{ hooks: [preToolUseHook] }]  // 必须配置
  }
};
```

### 2. Hook 的返回值格式

```typescript
// 允许执行
return { decision: 'approve' };

// 拒绝执行
return { decision: 'block', reason: '拒绝原因' };

// 让 SDK 自行决定（显示默认权限提示）
return {};
```

### 3. Hook 输入参数

```typescript
interface PreToolUseHookInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;      // 工具名称：Write, Bash, Edit 等
  tool_input: ToolInput;  // 工具参数
  session_id: string;
  cwd: string;
}
```

### 4. 测试清单

添加多模态功能时，务必测试以下场景：

- [ ] 纯文本消息 + Write 工具 → 权限弹窗
- [ ] 纯文本消息 + Bash 工具 → 权限弹窗
- [ ] 图片+文本消息 + Write 工具 → 权限弹窗
- [ ] 图片+文本消息 + Bash 工具 → 权限弹窗
- [ ] 拒绝权限后工具不执行

## 相关文件

- `claude-bridge/services/message-service.js` - 消息发送逻辑
- `claude-bridge/permission-handler.js` - 权限处理逻辑
- `docs/claude-agent-sdk.md` - SDK 官方文档参考

## 参考资料

- [Claude Agent SDK - Hooks 文档](docs/claude-agent-sdk.md#钩子类型)
- [Claude Agent SDK - CanUseTool 类型](docs/claude-agent-sdk.md#canusetool)


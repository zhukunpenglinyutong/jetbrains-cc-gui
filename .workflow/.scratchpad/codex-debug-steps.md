# Codex 无回复问题诊断步骤

## 问题分析

根据代码分析，Codex 消息处理流程应该是：
1. 前端选择 Codex provider
2. 前端发送 `set_provider` 消息到后端
3. 后端 SettingsHandler 设置 `session.setProvider("codex")`
4. 发送消息时，ClaudeSession 根据 provider 选择使用 Codex 或 Claude

**当前症状：**
- 使用 Codex 发送消息后没有任何回复
- 后端日志中没有任何 Codex 相关的日志（应该有 `[DEBUG] Codex sendMessage called` 等）
- 说明 ClaudeSession 没有调用 CodexSDKBridge

## 可能原因

1. **Provider 未正确设置**：SessionState 默认 provider 是 "claude"，如果前端没有成功设置为 "codex"，会一直使用 Claude
2. **后端日志缺失关键信息**：日志中应该有 `Setting provider to: codex`，但没有看到
3. **Session 重启后 provider 被重置**

## 诊断步骤

### 步骤 1：检查后端日志

在完整的 IDEA 日志中搜索以下关键词（不是只看你发给我的那部分）：
```
Setting provider to
```

如果找不到这一行，说明前端的 set_provider 消息没有被后端接收。

### 步骤 2：检查前端状态

打开浏览器开发者工具（右键点击 webview → Inspect），在 Console 中执行：
```javascript
console.log('Current Provider:', window.currentProvider || 'undefined')
```

应该显示 `Current Provider: codex`

### 步骤 3：手动设置 provider

在浏览器控制台执行：
```javascript
if (window.sendToJava) {
  window.sendToJava('set_provider:codex');
  console.log('✓ Sent set_provider:codex');
}
```

然后重新发送一条测试消息，查看是否有反应。

### 步骤 4：检查 CodexSDKBridge 初始化

搜索 IDEA 日志中是否有：
```
CodexSDKBridge
Command: /path/to/node
```

如果有这些日志，说明 Codex 正在被调用。

## 快速修复方案

如果确认是 provider 设置问题，可以尝试以下修复：

### 方案 A：前端强制发送 provider
在每次发送消息前，确保 provider 已设置。

### 方案 B：添加调试日志
临时在关键位置添加日志，确认执行流程。

## 下一步行动

请执行诊断步骤并告诉我结果，我会根据你的反馈提供具体的代码修复。

# Codex 输出显示问题调试指南

## 问题描述
使用 Codex 时，命令执行后页面没有显示实际输出内容。

## 已修复的问题
✅ **aggregated_output 字段检查** - 已在 `message-service.js:195` 行优先检查 `aggregated_output` 字段

## 新增调试日志
为了诊断问题，我们添加了以下调试日志：

### 1. Node.js 端 (ai-bridge/services/codex/message-service.js)
- **第179-184行**: 检查输出字段是否存在
  ```
  [DEBUG] Checking output fields: {hasAggregatedOutput, hasOutput, hasStdout, hasResult}
  ```

- **第201行**: 输出内容长度和预览
  ```
  [DEBUG] Found output, length: XXX, first 100 chars: ...
  ```

- **第210行**: 确认数据发送
  ```
  [DEBUG] Sending output to UI via [CONTENT_DELTA]
  ```

### 2. Java 端 (ClaudeSession.java)
- **第439行**: 接收到 content_delta
  ```
  [DEBUG] Codex content_delta received, length: XXX, preview: ...
  ```

- **第445行 / 448行**: 消息创建/更新
  ```
  [DEBUG] Created new assistant message, total messages: X
  [DEBUG] Updated existing assistant message, new content length: XXX
  ```

- **第452行**: UI 更新通知
  ```
  [DEBUG] notifyMessageUpdate() called, total messages: X
  ```

### 3. WebView 端 (ClaudeSDKToolWindow.java)
- **第807-811行**: 消息发送到 WebView
  ```
  [DEBUG] Sending X messages to WebView, JSON length: XXX
  [DEBUG] Last message: type=..., content length=XXX
  ```

## 测试步骤

1. **重新编译项目**
   ```bash
   ./gradlew clean build
   ```

2. **重启 IDEA 插件**
   - 在 IDEA 中重新加载插件

3. **发送测试消息给 Codex**
   - 使用简单的命令，例如：`列出当前目录的文件`

4. **检查日志**
   查看 IDEA 日志文件中的调试信息：
   - macOS: `~/Library/Logs/JetBrains/IntelliJIdea*/idea.log`
   - Windows: `%USERPROFILE%\AppData\Local\JetBrains\IntelliJIdea*\log\idea.log`

   关键日志顺序应该是：
   ```
   [DEBUG] Checking output fields: ...
   [DEBUG] Found output, length: ...
   [DEBUG] Sending output to UI via [CONTENT_DELTA]
   [DEBUG] Codex content_delta received, length: ...
   [DEBUG] Created new assistant message / Updated existing assistant message
   [DEBUG] notifyMessageUpdate() called, total messages: ...
   [DEBUG] Sending X messages to WebView, JSON length: ...
   ```

5. **检查浏览器控制台**
   - 打开 IDEA 的 WebView 开发者工具
   - 查看是否有 JavaScript 错误
   - 检查是否调用了 `window.updateMessages`

## 可能的问题和解决方案

### 问题 1: aggregated_output 为空
**日志特征**:
```
[DEBUG] Checking output fields: {hasAggregatedOutput: false, ...}
[DEBUG] No output found in any field
```

**解决方案**: Codex SDK 版本可能不同，输出字段名称可能变化。检查 Codex SDK 文档。

### 问题 2: 输出被过滤
**日志特征**:
```
[DEBUG] Found output, length: XXX
[DEBUG] Output is empty after trim
```

**解决方案**: 输出内容全是空白字符，检查 Codex 命令是否正确执行。

### 问题 3: Java 端未接收到数据
**日志特征**:
- 看到 `[DEBUG] Sending output to UI via [CONTENT_DELTA]`
- 但没有看到 `[DEBUG] Codex content_delta received`

**解决方案**: 检查 `CodexSDKBridge.java` 中的 `[CONTENT_DELTA]` 解析逻辑。

### 问题 4: WebView 未更新
**日志特征**:
- 看到 `[DEBUG] Sending X messages to WebView`
- 但页面没有更新

**解决方案**:
1. 检查浏览器控制台是否有 JavaScript 错误
2. 检查 `window.updateMessages` 是否被调用
3. 检查 `App.tsx` 中的消息过滤逻辑 (`shouldShowMessage`)

## 数据流追踪

完整的数据流应该是：

```
1. Codex SDK 返回 event.item.aggregated_output
   ↓
2. message-service.js 提取输出并打印 [CONTENT_DELTA]
   ↓
3. CodexSDKBridge.java 解析 [CONTENT_DELTA] 并调用 callback.onMessage()
   ↓
4. ClaudeSession.java 追加内容并调用 notifyMessageUpdate()
   ↓
5. ClaudeSDKToolWindow.java 调用 callJavaScript("updateMessages", ...)
   ↓
6. App.tsx window.updateMessages 更新 React 状态
   ↓
7. 页面渲染显示输出
```

## 联系支持

如果问题仍然存在，请提供：
1. 完整的日志输出（从测试命令发送到结束）
2. 浏览器控制台的错误信息
3. 使用的 Codex 命令和预期输出
4. IDEA 和插件版本信息

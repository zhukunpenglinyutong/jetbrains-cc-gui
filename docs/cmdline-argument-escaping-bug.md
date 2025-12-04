# 命令行参数特殊字符解析问题

## 问题描述

在 Windows PowerShell 环境中，通过 `ProcessBuilder` 将用户输入作为命令行参数传递给 Node.js 进程时，如果用户输入包含特殊字符（如括号、引号、换行符等），会导致参数被错误解析和拆分。

### 典型错误表现

用户发送包含代码片段的消息：
```go
queryBuild := data.DB.Table("flight_record").
    Where("deleted_at is null").
    Order(fmt.Sprintf("CASE WHEN inspection_status = %d THEN 0..."))
```

在 Node.js 端收到的参数会被错误拆分：
- `args[0]` (message): 只包含部分消息
- `args[1]` (sessionId): 变成 `"null).\r\n\t\tOrder(fmt.Sprintf(CASE"`
- `args[2]` (cwd): 变成 `"inspection_status"`

### 问题原因

Windows PowerShell 对命令行参数有特殊的解析规则：
1. 括号 `()` 被解释为子表达式
2. 引号 `"` 需要特殊转义
3. 换行符 `\r\n` 会分割参数
4. 百分号 `%` 可能触发变量替换

## 解决方案

**通过 stdin 传递参数，而不是命令行参数。**

### Java 端实现

```java
// 1. 构建 JSON 对象
JsonObject stdinInput = new JsonObject();
stdinInput.addProperty("message", message);
stdinInput.addProperty("sessionId", sessionId);
// ... 其他参数
String stdinJson = gson.toJson(stdinInput);

// 2. 构建命令（不包含用户输入）
List<String> command = new ArrayList<>();
command.add(node);
command.add(scriptPath);
command.add("send");  // 只传固定的命令名称

// 3. 设置环境变量
ProcessBuilder pb = new ProcessBuilder(command);
pb.environment().put("CLAUDE_USE_STDIN", "true");

// 4. 启动进程后写入 stdin
Process process = pb.start();
try (OutputStream stdin = process.getOutputStream()) {
    stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
    stdin.flush();
}
```

### Node.js 端实现

```javascript
// 读取 stdin 数据
async function readStdinData() {
  if (process.env.CLAUDE_USE_STDIN !== 'true') {
    return null;
  }
  
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    
    // 超时回退
    setTimeout(() => resolve(null), 100);
  });
}

// 使用时
const stdinData = await readStdinData();
if (stdinData && stdinData.message !== undefined) {
  // 从 stdin 读取参数
  const { message, sessionId, cwd } = stdinData;
} else {
  // 向后兼容：从命令行参数读取
  const [message, sessionId, cwd] = process.argv.slice(3);
}
```

## 受影响的文件

已修复的文件列表：

| 文件 | 方法/函数 |
|------|-----------|
| `ClaudeSDKBridge.java` | `sendMessageWithChannel()` |
| `ClaudeSDKBridge.java` | `executeQuerySync()` |
| `ClaudeSDKBridge.java` | `executeQueryStream()` |
| `ClaudeSDKTest.java` | `executeQuery()` |
| `channel-manager.js` | `send` 和 `sendWithAttachments` 命令 |
| `simple-query.js` | `getUserPrompt()` |

## 开发注意事项

⚠️ **重要规则**：

1. **永远不要**通过命令行参数传递用户输入的自由文本
2. **始终使用** stdin + JSON 的方式传递可能包含特殊字符的数据
3. 只有固定的、已知安全的值（如命令名称、UUID）可以通过命令行参数传递
4. 新增任何调用 Node.js 脚本的代码时，必须检查是否涉及用户输入

## 复现 Bug 的测试用例

以下消息可以在**未修复版本**中稳定复现此 bug：

### 测试用例 1：包含括号和引号的 Go 代码
```
queryBuild := data.DB.Table("flight_record").Where("deleted_at is null")
```

### 测试用例 2：包含 fmt.Sprintf 的代码
```
fmt.Sprintf("CASE WHEN status = %d THEN 0", constant.StatusRunning)
```

### 测试用例 3：包含换行和缩进的多行代码
```
if err != nil {
    return fmt.Errorf("failed: %w", err)
}
```

### 测试用例 4：包含 SQL 语句
```
SELECT * FROM users WHERE name = 'test' AND status IN (1, 2, 3)
```

### 测试用例 5：包含 JSON 字符串
```
{"key": "value", "array": [1, 2, 3]}
```

### 测试用例 6：Windows 路径
```
C:\Users\test\Documents\file (1).txt
```


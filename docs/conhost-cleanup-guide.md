# conhost.exe 清理功能使用指南

## 📋 功能概述

新增了专门的 `conhost.exe` 清理逻辑，用于解决 Windows 系统中多个控制台窗口主机进程累积的问题。

## 🔧 实现细节

### 1. 新增方法 (PlatformUtils.java)

#### `cleanupOrphanedConhosts(long parentPid)`
- 清理指定进程的孤儿 conhost.exe 子进程
- 在终止父进程后自动调用
- 使用 WMIC 查找父进程关系

#### `cleanupAllPluginConhosts()`
- 清理所有插件相关的 conhost.exe 进程
- 查找 node.exe、claude.exe、codex.exe 的 conhost 子进程
- 适用于 IDE 关闭时的全局清理

### 2. 增强的清理点 (ProcessManager.java)

#### 自动清理触发点：
1. **中断通道时** (`interruptChannel`)
   - 终止进程后立即清理其 conhost.exe

2. **全局清理时** (`cleanupAllProcesses`)
   - IDE 关闭或插件卸载时清理所有 conhost.exe

3. **手动清理** (`manualConhostCleanup`)
   - 新增公共方法，可手动触发清理

## 🚀 使用方法

### 自动清理（默认启用）
无需任何操作，以下情况会自动触发：
- 停止任务时
- 关闭会话时
- IDE 关闭时
- 切换项目时

### 手动清理
如需手动触发清理，可运行以下 PowerShell 命令查看效果：

```powershell
# 查看清理前的进程数量
Get-Process | Where-Object {$_.ProcessName -eq "conhost"} | Measure-Object

# 查看进程树关系
Get-CimInstance Win32_Process | Where-Object {$_.Name -match "node|claude|conhost"} | 
    Select-Object ProcessId, Name, ParentProcessId | 
    Format-Table -AutoSize
```

## 🔍 验证清理效果

### 方法 1: 任务管理器
1. 打开任务管理器 (Ctrl+Shift+Esc)
2. 切换到"详细信息"标签
3. 查找 `conhost.exe` 进程数量
4. 执行一些操作后观察数量变化

### 方法 2: PowerShell
```powershell
# 实时监控 conhost.exe 数量
while ($true) {
    Clear-Host
    $count = (Get-Process | Where-Object {$_.ProcessName -eq "conhost"}).Count
    Write-Host "conhost.exe 进程数: $count"
    Start-Sleep -Seconds 5
}
```

## 📊 预期效果

### 清理前：
```
node.exe (PID: 1234) 
  ├─ conhost.exe (PID: 5678) 
  ├─ conhost.exe (PID: 5679) 
  └─ conhost.exe (PID: 5680) 
```

### 清理后：
```
只有必要的 conhost.exe 进程保留
多余的 conhost.exe 被清理
```

## 🛠️ 故障排除

### 如果清理不生效：

1. **检查权限**：确保有足够的权限终止进程
2. **查看日志**：检查 IDE 日志中的 `[ProcessCleanup]` 相关信息
3. **手动清理**：使用 PowerShell 手动终止
   ```powershell
   Get-Process conhost -ErrorAction SilentlyContinue | Stop-Process -Force
   ```

### 如果出现错误：

1. **WMIC 不可用**：某些 Windows 版本可能需要 WMIC
2. **进程被锁定**：可能有其他程序正在使用这些进程
3. **权限不足**：尝试以管理员身份运行 IDE

## 📝 技术细节

### 实现原理：
1. **进程关系查找**：使用 WMIC 查找父子进程关系
2. **精确清理**：只清理插件相关的 conhost.exe，避免影响系统进程
3. **安全机制**：添加超时和错误处理，避免阻塞主线程

### 兼容性：
- ✅ Windows 10/11
- ✅ Windows Server 2016+
- ⚠️ 需要 WMIC 支持（Windows 11 22H2+ 可能需要额外启用）

## 🔄 回滚方案

如果新功能出现问题，可以通过以下方式禁用：

1. **修改代码**：注释掉 `PlatformUtils.java` 中的相关调用
2. **配置开关**：在设置中添加功能开关（未来版本）

## 📞 反馈

如遇到问题或有改进建议，请通过以下方式反馈：
- GitHub Issues
- 插件内反馈功能
- 日志文件分析
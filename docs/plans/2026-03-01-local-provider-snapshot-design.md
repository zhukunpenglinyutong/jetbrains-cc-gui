# 本地提供商快照功能设计

**日期**: 2026-03-01
**作者**: Claude Sonnet 4.5
**状态**: 已批准

## 问题描述

当用户使用"本地 settings.json"提供商时，切换到其他供应商会修改 `~/.claude/settings.json` 配置。切换回本地提供商时，之前的配置已经丢失，无法恢复。

### 用户场景

```
步骤1: 用户在本地提供商下手动配置了 settings.json
步骤2: 切换到供应商A（ccNexus）
步骤3: settings.json 被供应商A的配置覆盖
步骤4: 切换回本地提供商
步骤5: 无法恢复步骤1的原始配置
```

## 解决方案

为"本地 settings.json"提供商添加手动快照功能，允许用户备份和恢复配置。

### 核心特性

1. **手动快照管理**：完全由用户控制，无自动保存
2. **简单明了**：两个按钮（保存快照、恢复快照）
3. **系统内置**：本地提供商不可删除
4. **清晰提示**：告知用户快照的作用和使用场景

## 设计方案

### UI 设计

#### 本地 settings.json 提供商卡片

```
┌─────────────────────────────────────────────────┐
│ 📄 本地 settings.json                    [使用中] │
│                                                 │
│ 直接使用 ~/.claude/settings.json 配置           │
│                                                 │
│ 💡 快照功能：                                   │
│ • 切换供应商会修改 ~/.claude/settings.json     │
│ • 切换前建议先"保存快照"备份配置                │
│ • 之后可随时"恢复快照"还原配置                  │
│                                                 │
│ 💾 最后快照：2026-03-01 15:30:25               │
│                                                 │
│ [💾 保存快照]  [🔄 恢复快照]                    │
└─────────────────────────────────────────────────┘
```

#### 无快照状态

```
┌─────────────────────────────────────────────────┐
│ 📄 本地 settings.json                    [使用中] │
│                                                 │
│ 直接使用 ~/.claude/settings.json 配置           │
│                                                 │
│ 💡 快照功能：                                   │
│ • 切换供应商会修改 ~/.claude/settings.json     │
│ • 切换前建议先"保存快照"备份配置                │
│ • 之后可随时"恢复快照"还原配置                  │
│                                                 │
│ ⚠️ 暂无快照                                    │
│                                                 │
│ [💾 保存快照]  [🔄 恢复快照(禁用)]              │
└─────────────────────────────────────────────────┘
```

#### 按钮行为

- **保存快照**
  - 始终可用
  - 点击后保存当前 `~/.claude/settings.json` 到快照文件
  - 显示成功提示："快照已保存"
  - 更新快照时间戳显示

- **恢复快照**
  - 仅当快照文件存在时可用
  - 点击前弹出确认对话框
  - 确认消息："确定要恢复快照吗？当前的 settings.json 配置将被覆盖。"
  - 恢复成功后显示提示："配置已恢复"

### 后端实现

#### 快照文件

**位置**: `~/.codemoss/local-provider-snapshot.json`

**文件结构**:
```json
{
  "timestamp": "2026-03-01T15:30:25.123Z",
  "settings": {
    "env": { ... },
    "model": "...",
    "mcpServers": { ... },
    ...
  }
}
```

#### Java API

在 `ProviderManager.java` 中新增方法：

```java
/**
 * 保存本地提供商快照
 * @return 快照的时间戳
 */
public String saveLocalProviderSnapshot() throws IOException

/**
 * 恢复本地提供商快照
 * @return 是否成功恢复
 */
public boolean restoreLocalProviderSnapshot() throws IOException

/**
 * 获取快照信息（是否存在、时间戳）
 * @return JsonObject 包含 exists 和 timestamp 字段
 */
public JsonObject getLocalProviderSnapshotInfo() throws IOException
```

#### 消息处理

在 `ProviderHandler.java` 中新增：

```java
private void handleSaveLocalSnapshot(String content)
private void handleRestoreLocalSnapshot(String content)
private void handleGetSnapshotInfo(String content)
```

#### 前端交互流程

**保存快照**:
```
1. 用户点击"保存快照"按钮
2. 前端发送消息: save_local_snapshot
3. Java 后端读取 ~/.claude/settings.json
4. 保存到 ~/.codemoss/local-provider-snapshot.json（包含时间戳）
5. 返回成功，UI 显示 toast 提示和更新时间戳
```

**恢复快照**:
```
1. 用户点击"恢复快照"按钮
2. 弹出确认对话框
3. 用户确认后，发送消息: restore_local_snapshot
4. Java 后端从快照文件读取配置
5. 写入到 ~/.claude/settings.json
6. 返回成功，UI 显示 toast 提示
```

**获取快照信息**:
```
1. 页面加载时，发送消息: get_snapshot_info
2. Java 后端检查快照文件是否存在
3. 返回 { exists: true/false, timestamp: "..." }
4. UI 根据返回结果启用/禁用"恢复快照"按钮，显示时间戳
```

### 技术细节

#### 不可变性原则

快照操作遵循不可变性原则：

```java
// 保存快照时
JsonObject settings = claudeSettingsManager.readClaudeSettings();
JsonObject snapshot = new JsonObject();
snapshot.addProperty("timestamp", Instant.now().toString());
snapshot.add("settings", settings.deepCopy()); // 深拷贝，避免引用

// 恢复快照时
JsonObject snapshot = readSnapshot();
JsonObject settings = snapshot.getAsJsonObject("settings").deepCopy();
claudeSettingsManager.writeClaudeSettings(settings);
```

#### 错误处理

- 快照文件不存在：返回友好提示，禁用恢复按钮
- 快照文件损坏：记录错误日志，提示用户快照无效
- 权限问题：捕获 IOException，提示用户检查文件权限

#### 文件操作安全性

- 使用原子写入操作
- 写入前验证 JSON 格式
- 写入失败时保留原文件

## 实现清单

### 后端开发

1. 在 `ProviderManager.java` 中实现快照 API
   - `saveLocalProviderSnapshot()`
   - `restoreLocalProviderSnapshot()`
   - `getLocalProviderSnapshotInfo()`

2. 在 `ProviderHandler.java` 中添加消息处理
   - `handleSaveLocalSnapshot()`
   - `handleRestoreLocalSnapshot()`
   - `handleGetSnapshotInfo()`

3. 更新消息路由，注册新的消息类型

### 前端开发

1. 更新本地提供商卡片 UI
   - 添加快照功能提示文案
   - 添加"保存快照"按钮
   - 添加"恢复快照"按钮
   - 显示快照时间戳或"暂无快照"状态

2. 实现快照功能逻辑
   - `handleSaveSnapshot()` - 调用保存快照 API
   - `handleRestoreSnapshot()` - 显示确认对话框，调用恢复 API
   - `loadSnapshotInfo()` - 页面加载时获取快照信息
   - 根据快照存在状态控制按钮启用/禁用

3. 添加用户反馈
   - 保存成功 toast
   - 恢复成功 toast
   - 错误提示

4. 移除本地提供商的删除按钮

### 测试计划

1. **单元测试**
   - 快照保存功能
   - 快照恢复功能
   - 快照信息获取
   - 边界情况：文件不存在、文件损坏

2. **集成测试**
   - 完整的保存-恢复流程
   - 切换供应商后恢复快照
   - 多次保存覆盖快照

3. **E2E 测试**
   - 用户在本地提供商下保存快照
   - 切换到其他供应商
   - 切换回本地提供商并恢复快照
   - 验证配置正确恢复

## 非功能需求

- **性能**: 快照操作应在 100ms 内完成
- **可靠性**: 文件操作必须原子化，避免部分写入
- **用户体验**: 所有操作提供即时反馈
- **向后兼容**: 不影响现有提供商的功能

## 未来优化方向

1. **多版本快照**: 支持保存多个快照版本，带时间戳选择
2. **自动快照**: 切换供应商时可选自动保存
3. **快照对比**: 显示快照与当前配置的差异
4. **导出/导入**: 支持快照文件的导出和导入

## 风险评估

- **低风险**: UI 修改仅影响本地提供商卡片
- **低风险**: 新增 API 不影响现有功能
- **中风险**: 文件操作需要充分的错误处理
- **缓解措施**: 完善的单元测试和集成测试

## 批准记录

- **设计审查**: 2026-03-01 - 已批准
- **用户确认**: 使用简洁版提示文案
- **快照策略**: 仅手动保存，完全由用户控制
- **删除功能**: 本地提供商不提供删除按钮

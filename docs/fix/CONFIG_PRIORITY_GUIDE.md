# 配置优先级说明文档

**最后更新：** 2025-12-10
**适用版本：** v2.0+

---

## 📊 快速参考

### 配置优先级规则（统一）

```
系统环境变量 > ~/.claude/settings.json > 默认值
   (最高)              (中等)            (最低)
```

**重要提示：** 所有环境变量都遵循相同的优先级规则！

---

## 🎯 优先级说明（傻瓜版）

### 什么是配置优先级？

当同一个配置在多个地方都有设置时，系统会按照优先级选择使用哪一个。

**举例：**
```bash
# 场景：API Key 在两个地方都有设置

# 地方1：系统环境变量（在终端设置）
export ANTHROPIC_API_KEY="key_from_terminal"

# 地方2：配置文件 ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_API_KEY": "key_from_file"
  }
}

# 问题：系统应该用哪一个？
# 答案：用终端的！（系统环境变量优先级更高）
```

---

## 🔧 详细优先级规则

### 1️⃣ 系统环境变量（最高优先级）

**什么是系统环境变量？**
- 在终端用 `export` 命令设置的变量
- 只在当前终端会话中有效

**设置方法：**
```bash
# macOS / Linux
export ANTHROPIC_API_KEY="your-key-here"
export ANTHROPIC_BASE_URL="https://custom-url.com"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY="your-key-here"
$env:ANTHROPIC_BASE_URL="https://custom-url.com"
```

**何时使用：**
- ✅ 临时测试不同的 API Key
- ✅ 在 CI/CD 环境中使用
- ✅ 快速覆盖配置文件中的设置
- ✅ 不想修改配置文件时

**优先级：** 🔴 **最高** - 会覆盖配置文件中的相同变量

---

### 2️⃣ 配置文件 `~/.claude/settings.json`（中等优先级）

**什么是配置文件？**
- 保存在用户目录下的 JSON 格式配置
- 永久保存，重启后仍然有效

**位置：**
```
macOS/Linux: ~/.claude/settings.json
Windows: C:\Users\YourName\.claude\settings.json
```

**格式：**
```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "ANTHROPIC_BASE_URL": "https://custom-url.com",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "MY_CUSTOM_VAR": "value"
  }
}
```

**何时使用：**
- ✅ 设置默认的 API Key
- ✅ 配置常用的 Base URL
- ✅ 保存长期使用的自定义配置
- ✅ 在 GUI 中管理供应商配置

**优先级：** 🟡 **中等** - 会被系统环境变量覆盖

---

### 3️⃣ 默认值（最低优先级）

**什么是默认值？**
- 系统预设的配置
- 只在没有任何其他配置时使用

**默认值列表：**
```javascript
ANTHROPIC_BASE_URL = "https://api.anthropic.com"  // 官方 API 地址
其他环境变量 = undefined  // 无默认值
```

**优先级：** 🟢 **最低** - 任何其他配置都会覆盖默认值

---

## 📋 实际应用场景

### 场景 1: 正常使用（只用配置文件）

```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-production-key",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  }
}
```

**结果：**
- ✅ 使用配置文件中的 API Key
- ✅ 使用配置文件中的 Base URL

**适用于：** 日常使用、普通用户

---

### 场景 2: 临时测试不同的 API Key

```bash
# 终端设置临时 API Key
export ANTHROPIC_API_KEY="sk-ant-test-key"

# 启动程序
```

```json
// ~/.claude/settings.json（不需要修改）
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-production-key",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  }
}
```

**结果：**
- ✅ 使用终端设置的测试 API Key（环境变量优先）
- ✅ 使用配置文件中的 Base URL（未被覆盖）

**适用于：** 开发测试、临时切换配置

---

### 场景 3: 混合使用（部分覆盖）

```bash
# 终端设置（只覆盖 Base URL）
export ANTHROPIC_BASE_URL="https://test-proxy.com"
```

```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-key",
    "ANTHROPIC_BASE_URL": "https://production.com",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

**结果：**
- ✅ API Key: `sk-ant-key` （来自配置文件）
- ✅ Base URL: `https://test-proxy.com` （来自环境变量，覆盖了配置文件）
- ✅ DISABLE_TRAFFIC: `1` （来自配置文件）

**适用于：** 测试不同的代理服务器

---

## 🔍 如何确认当前使用的配置？

### 方法 1: 查看程序日志

启动程序后，查看日志输出：

```
[DEBUG] Loading environment variables from settings.json...
[DEBUG] Loaded 3 environment variables: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
[DEBUG] API Key source: environment (ANTHROPIC_API_KEY)  ← 来自系统环境变量
[DEBUG] Base URL: https://custom-url.com
[DEBUG] Base URL source: settings.json  ← 来自配置文件
```

**日志说明：**
- `environment (XXX)` = 使用系统环境变量
- `settings.json (XXX)` = 使用配置文件
- `default` = 使用默认值

---

### 方法 2: 运行测试脚本

```bash
cd ai-bridge
node test-priority.js
```

**输出示例：**
```
🧪 测试配置优先级
========================================

📋 测试场景 1: 只有 settings.json 配置
----------------------------------------
1️⃣ 清理系统环境变量
   - 删除 ANTHROPIC_API_KEY
   ...

4️⃣ 验证结果
   ✅ 配置已从 settings.json 加载到 process.env

📋 测试场景 2: 系统环境变量覆盖 settings.json
----------------------------------------
...
4️⃣ 验证优先级是否正确
   ✅ ANTHROPIC_API_KEY: 系统环境变量生效（正确！）
   ✅ ANTHROPIC_BASE_URL: 系统环境变量生效（正确！）
   ✅ TEST_CUSTOM_VAR: 系统环境变量生效（正确！）

5️⃣ 优先级规则验证
   规则: 系统环境变量 > settings.json
   状态: ✅ 所有配置都遵循统一的优先级规则
```

---

## 🛠️ 常见问题

### Q1: 我修改了 settings.json，但配置没生效？

**A:** 检查是否设置了同名的系统环境变量：

```bash
# 检查系统环境变量
echo $ANTHROPIC_API_KEY  # macOS/Linux
echo %ANTHROPIC_API_KEY%  # Windows CMD
echo $env:ANTHROPIC_API_KEY  # Windows PowerShell
```

如果输出不为空，说明系统环境变量正在覆盖配置文件。

**解决方案：**
```bash
# 删除系统环境变量
unset ANTHROPIC_API_KEY  # macOS/Linux
Remove-Item Env:\ANTHROPIC_API_KEY  # Windows PowerShell
```

---

### Q2: 如何临时切换到不同的配置？

**A:** 使用系统环境变量：

```bash
# 临时使用测试 API Key
export ANTHROPIC_API_KEY="test-key"
export ANTHROPIC_BASE_URL="https://test-url.com"

# 启动程序（会使用临时配置）
./your-program

# 下次启动时，如果不设置环境变量，会恢复使用配置文件的值
```

---

### Q3: GUI 中切换供应商会影响系统环境变量吗？

**A:** 不会！GUI 只会修改 `~/.claude/settings.json`，不会修改系统环境变量。

**流程：**
```
用户在 GUI 切换供应商
   ↓
更新 ~/.claude/settings.json
   ↓
如果没有设置系统环境变量 → 使用新的配置文件
如果设置了系统环境变量 → 系统环境变量仍然优先
```

---

### Q4: 为什么要设计这样的优先级？

**A:** 这是业界标准做法，原因：

1. **灵活性** - 可以快速测试不同配置，无需修改文件
2. **安全性** - CI/CD 环境可以用环境变量覆盖配置
3. **一致性** - 所有环境变量都遵循相同规则，不易混淆
4. **可预���性** - 用户知道系统环境变量总是最高优先级

---

## 📊 优先级对比表

| 配置源 | API Key | Base URL | 自定义变量 | 优先级 |
|-------|---------|----------|-----------|-------|
| **系统环境变量** | ✅ 最高 | ✅ 最高 | ✅ 最高 | 🔴 1 |
| **settings.json** | ✅ 中等 | ✅ 中等 | ✅ 中等 | 🟡 2 |
| **默认值** | ❌ 无 | ✅ 最低 | ❌ 无 | 🟢 3 |

**说明：**
- ✅ = 支持此配置源
- ❌ = 不支持/无默认值

---

## 🎯 最佳实践建议

### ✅ 推荐做法

1. **日常使用** - 在 GUI 中配置供应商，保存到 settings.json
2. **临时测试** - 使用 `export` 命令设置环境变量
3. **CI/CD** - 在构建脚本中设置环境变量
4. **多环境** - 不同环境用不同的 settings.json

### ❌ 避免做法

1. ❌ 同时在环境变量和配置文件中设置相同变量（容易混淆）
2. ❌ 在生产环境中使用临时环境变量（应该用配置文件）
3. ❌ 手动编辑 settings.json 后不检查环境变量
4. ❌ 覆盖系统关键变量（如 PATH、HOME 等）

---

## 📝 版本历史

### v2.0 (2025-12-10)
- 🔄 **统一配置优先级** - 所有环境变量都使用相同规则
- ✅ **修复** - API Key 和 Base URL 现在也遵循"环境变量优先"
- 📝 **改进** - 更详细的日志输出，显示配置来源

### v1.0 (之前版本)
- ⚠️ **不一致** - API Key 和其他变量使用不同的优先级
- 问题：容易混淆，难以调试

---

**文档结束**

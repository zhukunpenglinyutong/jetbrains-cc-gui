# SDK 懒加载架构设计文档

## 一、架构概述

### 1.1 设计目标

将 AI SDK（Claude Agent SDK、Codex SDK）从插件包中分离，实现按需安装，以：
- 减小插件包体积
- 支持用户选择性安装所需 SDK
- 便于 SDK 独立更新

### 1.2 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         IntelliJ Plugin                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │   Webview   │◄──►│    Java     │◄──►│   Node.js Runtime   │  │
│  │  (React)    │    │   Backend   │    │    (ai-bridge)      │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
│         │                  │                      │              │
│         ▼                  ▼                      ▼              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  SDK 状态   │    │ Dependency  │    │    SDK Loader       │  │
│  │   显示      │    │  Manager    │    │  (动态加载 SDK)     │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │   ~/.codemoss/dependencies/    │
              ├────────────────────────────────┤
              │  ├── claude-sdk/               │
              │  │   └── node_modules/         │
              │  │       └── @anthropic-ai/    │
              │  │           ├── claude-agent-sdk │
              │  │           ├── sdk           │
              │  │           └── bedrock-sdk   │
              │  └── codex-sdk/                │
              │      └── node_modules/         │
              │          └── @openai/          │
              │              └── codex-sdk     │
              └────────────────────────────────┘
```

---

## 二、模块职责

### 2.1 Java 后端 - DependencyManager

**位置**: `src/main/java/.../DependencyManager.java`

**职责**:
- SDK 安装/卸载操作（调用 npm）
- 检测 SDK 安装状态
- 获取已安装版本
- 向前端推送状态更新

**核心方法**:
```java
public class DependencyManager {
    // 安装目录
    private static final String DEPS_DIR = System.getProperty("user.home")
        + "/.codemoss/dependencies";

    // 检查是否已安装
    public boolean isInstalled(String sdkId);

    // 获取安装版本
    public String getInstalledVersion(String sdkId);

    // 获取所有 SDK 状态（返回 JSON）
    public JsonObject getAllSdkStatus();

    // 安装 SDK
    public void installSdk(String sdkId);

    // 卸载 SDK
    public void uninstallSdk(String sdkId);
}
```

**状态数据格式**:
```json
{
  "claude-sdk": {
    "id": "claude-sdk",
    "installed": true,
    "status": "installed",
    "installedVersion": "1.0.0",
    "version": "1.0.0",
    "installPath": "/Users/xxx/.codemoss/dependencies/claude-sdk"
  },
  "codex-sdk": {
    "id": "codex-sdk",
    "installed": false,
    "status": "not_installed"
  }
}
```

### 2.2 Node.js 运行时 - SDK Loader

**位置**: `ai-bridge/utils/sdk-loader.js`

**职责**:
- 动态加载已安装的 SDK
- SDK 缓存管理
- SDK 可用性检测

**核心设计**:

```javascript
// SDK 安装路径
const DEPS_BASE = join(homedir(), '.codemoss', 'dependencies');

// SDK 缓存（避免重复加载）
const sdkCache = new Map();

// 动态加载 SDK
export async function loadClaudeSdk() {
    // 1. 检查缓存
    if (sdkCache.has('claude')) {
        return sdkCache.get('claude');
    }

    // 2. 检查是否安装
    const sdkPath = getClaudeSdkPath();
    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:claude');
    }

    // 3. 动态加载（必须用 import() 而非 require()）
    // ⚠️ 注意：Node.js 的 ES Module 不支持 import(目录路径)，需要解析到具体入口文件（如 sdk.mjs）
    //（示例伪代码，实际实现见 ai-bridge/utils/sdk-loader.js）
    const entryFile = resolveEntryFileFromPackageDir(sdkPath); // 读取 package.json 的 main/exports 等
    const sdk = await import(pathToFileURL(entryFile).href);

    // 4. 缓存并返回
    sdkCache.set('claude', sdk);
    return sdk;
}
```

**关键技术点 - ES Module 加载**:

```
┌─────────────────────────────────────────────────────────────┐
│                    模块系统对比                              │
├──────────────────┬──────────────────┬───────────────────────┤
│                  │    CommonJS      │      ES Module        │
├──────────────────┼──────────────────┼───────────────────────┤
│ 导入语法         │ require()        │ import               │
│ 导出语法         │ module.exports   │ export               │
│ 加载方式         │ 同步             │ 异步                  │
│ 文件扩展名       │ .js, .cjs        │ .js, .mjs            │
│ 动态加载         │ require()        │ import()             │
├──────────────────┴──────────────────┴───────────────────────┤
│ 重要：require() 无法加载 ES Module (.mjs)                    │
│ 解决方案：使用 动态 import()，它可以加载任何模块格式          │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 前端 - 状态管理与 UI

**涉及文件**:
- `webview/src/App.tsx` - 全局 SDK 状态管理
- `webview/src/components/settings/DependencySection/` - 设置页面
- `webview/src/components/ChatInputBox/` - 输入框遮罩

---

## 三、通信机制

### 3.1 Java ↔ Webview 通信

```
┌──────────────┐                              ┌──────────────┐
│   Webview    │                              │    Java      │
│   (React)    │                              │   Backend    │
└──────┬───────┘                              └──────┬───────┘
       │                                             │
       │  window.sendToJava('get_dependency_status:')│
       │────────────────────────────────────────────►│
       │                                             │
       │                                             │ 查询 SDK 状态
       │                                             │
       │  window.updateDependencyStatus(jsonStr)     │
       │◄────────────────────────────────────────────│
       │                                             │
       ▼                                             ▼
```

**消息类型**:
```
前端 → 后端:
  get_dependency_status:     请求 SDK 状态
  install_dependency:{json}  安装 SDK
  uninstall_dependency:{json} 卸载 SDK
  check_node_environment:    检查 Node.js 环境

后端 → 前端:
  window.updateDependencyStatus(json)    SDK 状态更新
  window.dependencyInstallProgress(json) 安装进度
  window.dependencyInstallResult(json)   安装结果
  window.dependencyUninstallResult(json) 卸载结果
  window.nodeEnvironmentStatus(json)     Node.js 环境状态
```

### 3.2 回调函数注册机制

**问题场景**:
多个 React 组件需要监听同一个 window 回调，但后注册的会覆盖先注册的。

```
┌─────────────────────────────────────────────────────────────┐
│                    回调覆盖问题                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  App.tsx 挂载时:                                            │
│    window.updateDependencyStatus = appCallback              │
│                                                             │
│  DependencySection 挂载时:                                  │
│    window.updateDependencyStatus = sectionCallback          │
│    // appCallback 被覆盖，App.tsx 收不到更新！              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**解决方案 - 装饰器模式**:

```
┌─────────────────────────────────────────────────────────────┐
│                    装饰器模式解决回调冲突                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. App.tsx 注册回调并保存引用:                              │
│     window.updateDependencyStatus = appCallback             │
│     window._appUpdateDependencyStatus = appCallback         │
│                                                             │
│  2. DependencySection 使用装饰器模式:                        │
│     const appCallback = window._appUpdateDependencyStatus   │
│     window.updateDependencyStatus = (json) => {             │
│         sectionCallback(json)  // 自己处理                  │
│         appCallback?.(json)    // 链式调用 App 的回调        │
│     }                                                       │
│                                                             │
│  3. 清理时恢复原回调:                                        │
│     window.updateDependencyStatus = appCallback             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**代码实现**:

```typescript
// App.tsx - 注册并保存引用
useEffect(() => {
    const original = window.updateDependencyStatus;

    window.updateDependencyStatus = (jsonStr: string) => {
        // 处理自己的逻辑
        const status = JSON.parse(jsonStr);
        setSdkStatus(status);

        // 链式调用（如果有其他回调）
        if (original && original !== window.updateDependencyStatus) {
            original(jsonStr);
        }
    };

    // 保存引用供其他组件使用
    (window as any)._appUpdateDependencyStatus = window.updateDependencyStatus;

    return () => {
        // 清理
    };
}, []);

// DependencySection/index.tsx - 装饰并链式调用
useEffect(() => {
    const appCallback = (window as any)._appUpdateDependencyStatus;

    window.updateDependencyStatus = (jsonStr: string) => {
        // 处理自己的逻辑
        const status = JSON.parse(jsonStr);
        setSdkStatus(status);
        setLoading(false);

        // 链式调用 App 的回调
        if (appCallback) {
            appCallback(jsonStr);
        }
    };

    return () => {
        // 恢复 App 的回调，而非 undefined
        if (appCallback) {
            window.updateDependencyStatus = appCallback;
        }
    };
}, []);
```

---

## 四、状态流转

### 4.1 SDK 状态生命周期

```
┌─────────────────────────────────────────────────────────────┐
│                    SDK 状态流转图                            │
└─────────────────────────────────────────────────────────────┘

     ┌──────────┐
     │ 未安装   │
     │not_installed│
     └────┬─────┘
          │
          │ 用户点击"安装"
          ▼
     ┌──────────┐
     │ 安装中   │ ◄─── 显示进度日志
     │installing│
     └────┬─────┘
          │
          ├─── 成功 ───►  ┌──────────┐
          │               │ 已安装   │
          │               │installed │
          │               └────┬─────┘
          │                    │
          │                    │ 用户点击"卸载"
          │                    ▼
          │               ┌──────────┐
          │               │ 卸载中   │
          │               │uninstalling│
          │               └────┬─────┘
          │                    │
          │                    │ 成功
          │                    ▼
          └─── 失败 ───►  ┌──────────┐
                         │ 未安装   │
                         │not_installed│
                         └──────────┘
```

### 4.2 前端状态初始化

```
┌─────────────────────────────────────────────────────────────┐
│                    初始化时序图                              │
└─────────────────────────────────────────────────────────────┘

  App.tsx                    Java                    用户界面
     │                         │                         │
     │ useEffect 挂载          │                         │
     │ sdkStatus = {}          │                         │
     │ currentSdkInstalled = true (默认)                 │
     │                         │                         │
     │ sendToJava('get_dependency_status:')              │
     │────────────────────────►│                         │
     │                         │                         │
     │                         │ 查询文件系统             │
     │                         │                         │
     │ updateDependencyStatus(json)                      │
     │◄────────────────────────│                         │
     │                         │                         │
     │ setSdkStatus(status)    │                         │
     │ currentSdkInstalled = 根据实际状态计算             │
     │                         │                         │
     │                         │                         │ 显示真实状态
     │                         │                         │
     ▼                         ▼                         ▼
```

**关键设计 - 初始状态处理**:

```typescript
// 计算当前 SDK 是否安装
const currentSdkInstalled = (() => {
    const sdkId = providerToSdk[currentProvider] || 'claude-sdk';
    const status = sdkStatus[sdkId];

    // 关键：状态未知时（还在加载），默认返回 true
    // 避免初始化时错误显示"未安装"遮罩层
    if (!status) return true;

    return status?.status === 'installed' || status?.installed === true;
})();
```

---

## 五、错误处理

### 5.1 SDK 未安装时的用户体验

```
┌─────────────────────────────────────────────────────────────┐
│                    输入框遮罩层设计                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ⚠️ SDK 未安装                    [前往安装]         │   │
│  │  ──────────────────────────────────────────────────  │   │
│  │  │ 输入框（禁用状态）                             │  │   │
│  │  └─────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  实现方式:                                                  │
│  - 半透明遮罩层覆盖输入框                                   │
│  - contentEditable={false} 禁用输入                         │
│  - 点击"前往安装"跳转到设置页依赖管理                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 JavaScript 作用域陷阱

```
┌─────────────────────────────────────────────────────────────┐
│                    try-catch 作用域问题                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  // 错误示例                                                │
│  try {                                                      │
│      let streamingEnabled = false;  // 块级作用域           │
│      // ... 业务逻辑                                        │
│  } catch (error) {                                          │
│      if (streamingEnabled) {  // ReferenceError!           │
│          // 无法访问 try 块内的变量                         │
│      }                                                      │
│  }                                                          │
│                                                             │
│  // 正确示例                                                │
│  let streamingEnabled = false;  // 提升到外层              │
│  try {                                                      │
│      streamingEnabled = true;                               │
│      // ... 业务逻辑                                        │
│  } catch (error) {                                          │
│      if (streamingEnabled) {  // 正常访问                  │
│          // 可以使用外层变量                                │
│      }                                                      │
│  }                                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 六、文件清单

| 层级 | 文件路径 | 职责 |
|------|----------|------|
| Java | `DependencyManager.java` | SDK 安装/卸载/状态管理 |
| Node | `ai-bridge/utils/sdk-loader.js` | 动态加载 SDK |
| Node | `ai-bridge/services/claude/message-service.js` | 消息发送服务 |
| React | `webview/src/App.tsx` | 全局 SDK 状态 |
| React | `webview/src/components/settings/DependencySection/` | 依赖管理 UI |
| React | `webview/src/components/ChatInputBox/` | 输入框 + 遮罩 |
| Types | `webview/src/types/dependency.ts` | 类型定义 |
| i18n | `webview/src/i18n/locales/*.json` | 国际化文本 |

---

## 七、扩展设计

### 7.1 添加新 SDK

1. **Java 端**: 在 `SdkDefinition` 枚举添加新 SDK 定义
2. **Node 端**: 在 `sdk-loader.js` 添加加载函数
3. **前端**: 在 `SDK_DEFINITIONS` 数组添加 UI 配置
4. **映射**: 更新 `providerToSdk` 映射关系

### 7.2 版本更新检测

```java
// DependencyManager.java
public boolean hasUpdate(String sdkId) {
    String installed = getInstalledVersion(sdkId);
    String latest = fetchLatestVersion(sdkId);  // npm view
    return !installed.equals(latest);
}
```

---

## 八、调试指南

### 8.1 日志查看

```javascript
// 前端日志（浏览器控制台）
console.log('[Frontend] SDK status updated:', status);

// Node.js 日志（JCEF 控制台）
console.log('[SDK-Loader] Loading Claude SDK from:', sdkPath);
```

### 8.2 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `require() of ES Module not supported` | SDK 是 ESM 格式 | 使用 `import()` 而非 `require()` |
| `streamingEnabled is not defined` | 变量作用域 | 将变量声明提升到 try 块外 |
| 设置页状态不同步 | 回调被覆盖 | 使用装饰器模式链式调用 |
| 初始化时显示"未安装" | 状态默认 false | 未知状态时默认 true |

import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './codicon.css';
import './styles/app.less';
import './i18n/config';
import i18n from './i18n/config';
import { setupSlashCommandsCallback } from './components/ChatInputBox/providers/slashCommandProvider';
import { sendBridgeEvent } from './utils/bridge';

function createBridgeHeartbeatStarter() {
  let started = false;

  return () => {
    if (started) return;
    started = true;

    let lastRafAt = Date.now();
    let rafId: number | null = null;
    const rafLoop = () => {
      lastRafAt = Date.now();
      rafId = requestAnimationFrame(rafLoop);
    };
    rafId = requestAnimationFrame(rafLoop);

    let sequence = 0;
    const intervalMs = 5000;

    let intervalId: number | null = null;
    intervalId = window.setInterval(() => {
      sequence += 1;
      const payload = JSON.stringify({
        ts: Date.now(),
        raf: lastRafAt,
        visibility: document.visibilityState,
        focus: document.hasFocus(),
        seq: sequence,
      });
      sendBridgeEvent('heartbeat', payload);
    }, intervalMs);

    const cleanup = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    // Explicitly cleanup timers on navigation/unload (best effort; helpful for long-running JCEF contexts).
    window.addEventListener('beforeunload', cleanup, { once: true });
    window.addEventListener('pagehide', cleanup, { once: true });

    // Cleanup on Vite HMR (dev only).
    if (import.meta.hot) {
      import.meta.hot.dispose(() => cleanup());
    }

    if (import.meta.env.DEV) {
      console.log('[Main] Bridge heartbeat enabled');
    }
  };
}

const startBridgeHeartbeat = createBridgeHeartbeatStarter();

// vConsole 调试工具
const enableVConsole =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_VCONSOLE === 'true';

if (enableVConsole) {
  void import('vconsole').then(({ default: VConsole }) => {
    new VConsole();
    // 将 vConsole 按钮移到左上角，避免遮挡右下角的发送按钮
    setTimeout(() => {
      const vcSwitch = document.getElementById('__vconsole') as HTMLElement;
      if (vcSwitch) {
        vcSwitch.style.left = '10px';
        vcSwitch.style.right = 'auto';
        vcSwitch.style.top = '10px';
        vcSwitch.style.bottom = 'auto';
      }
    }, 100);
  });
}

/**
 * 应用 IDEA 编辑器字体配置到 CSS 变量
 */
function applyFontConfig(config: { fontFamily: string; fontSize: number; lineSpacing: number; fallbackFonts?: string[] }) {
  const root = document.documentElement;

  // 构建字体族字符串，包含主字体、回落字体和系统默认回落
  const fontParts: string[] = [`'${config.fontFamily}'`];

  // 添加 IDEA 配置的回落字体
  if (config.fallbackFonts && config.fallbackFonts.length > 0) {
    for (const fallback of config.fallbackFonts) {
      fontParts.push(`'${fallback}'`);
    }
  }

  // 添加系统默认回落字体
  fontParts.push("'Consolas'", 'monospace');

  const fontFamily = fontParts.join(', ');

  root.style.setProperty('--idea-editor-font-family', fontFamily);
  root.style.setProperty('--idea-editor-font-size', `${config.fontSize}px`);
  root.style.setProperty('--idea-editor-line-spacing', String(config.lineSpacing));

  console.log('[Main] Applied IDEA font config:', config, 'fontFamily CSS:', fontFamily);
}

// 注册 applyIdeaFontConfig 函数
window.applyIdeaFontConfig = applyFontConfig;

// 检查是否有待处理的字体配置（Java 端可能先于 JS 执行）
if (window.__pendingFontConfig) {
  console.log('[Main] Found pending font config, applying...');
  applyFontConfig(window.__pendingFontConfig);
  delete window.__pendingFontConfig;
}

/**
 * 应用 IDEA 语言配置到 i18n
 * Only applies IDEA language if user hasn't manually set a language preference
 */
function applyLanguageConfig(config: { language: string; ideaLocale?: string }) {
  const { language } = config;

  // Check if user has manually set a language preference
  const manuallySet = localStorage.getItem('languageManuallySet') === 'true';
  if (manuallySet) {
    console.log('[Main] User has manually set language preference, skipping IDEA language config');
    return;
  }

  // 验证语言代码是否支持
  const supportedLanguages = ['zh', 'en', 'zh-TW', 'hi', 'es', 'fr', 'ja'];
  const targetLanguage = supportedLanguages.includes(language) ? language : 'en';

  console.log('[Main] Applying IDEA language config:', config, 'target language:', targetLanguage);

  // 切换 i18n 语言
  i18n.changeLanguage(targetLanguage)
    .then(() => {
      // 保存到 localStorage，以便下次启动时使用
      localStorage.setItem('language', targetLanguage);
      console.log('[Main] Language changed successfully to:', targetLanguage);
    })
    .catch((error) => {
      console.error('[Main] Failed to change language:', error);
    });
}

// 注册 applyIdeaLanguageConfig 函数
window.applyIdeaLanguageConfig = applyLanguageConfig;

// 检查是否有待处理的语言配置（Java 端可能先于 JS 执行）
if (window.__pendingLanguageConfig) {
  console.log('[Main] Found pending language config, applying...');
  applyLanguageConfig(window.__pendingLanguageConfig);
  delete window.__pendingLanguageConfig;
}

// 预注册 updateSlashCommands，避免后端调用早于 React 初始化
if (typeof window !== 'undefined' && !window.updateSlashCommands) {
  console.log('[Main] Pre-registering updateSlashCommands placeholder');
  window.updateSlashCommands = (json: string) => {
    console.log('[Main] Storing pending slash commands, length=' + json.length);
    window.__pendingSlashCommands = json;
  };
}

// 预注册 setSessionId，避免后端调用早于 React 初始化
// 这是 rewind 功能所需的会话 ID
if (typeof window !== 'undefined' && !window.setSessionId) {
  console.log('[Main] Pre-registering setSessionId placeholder');
  window.setSessionId = (sessionId: string) => {
    console.log('[Main] Storing pending session ID:', sessionId);
    (window as any).__pendingSessionId = sessionId;
  };
}

// 预注册 updateDependencyStatus，避免后端返回状态早于 React 初始化
if (typeof window !== 'undefined' && !window.updateDependencyStatus) {
  console.log('[Main] Pre-registering updateDependencyStatus placeholder');
  window.updateDependencyStatus = (json: string) => {
    console.log('[Main] Storing pending dependency status, length=' + (json ? json.length : 0));
    window.__pendingDependencyStatus = json;
  };
}

// 预注册 dependencyUpdateAvailable，避免后端检查更新早于 Settings/React 初始化
if (typeof window !== 'undefined' && !window.dependencyUpdateAvailable) {
  console.log('[Main] Pre-registering dependencyUpdateAvailable placeholder');
  window.dependencyUpdateAvailable = (json: string) => {
    console.log('[Main] Storing pending dependency updates, length=' + (json ? json.length : 0));
    window.__pendingDependencyUpdates = json;
  };
}

// 预注册 updateStreamingEnabled，避免后端返回状态早于 React 初始化
if (typeof window !== 'undefined' && !window.updateStreamingEnabled) {
  console.log('[Main] Pre-registering updateStreamingEnabled placeholder');
  window.updateStreamingEnabled = (json: string) => {
    console.log('[Main] Storing pending streaming enabled status, length=' + (json ? json.length : 0));
    window.__pendingStreamingEnabled = json;
  };
}

// 预注册 updateSendShortcut，避免后端返回状态早于 React 初始化
if (typeof window !== 'undefined' && !window.updateSendShortcut) {
  console.log('[Main] Pre-registering updateSendShortcut placeholder');
  window.updateSendShortcut = (json: string) => {
    console.log('[Main] Storing pending send shortcut status, length=' + (json ? json.length : 0));
    window.__pendingSendShortcut = json;
  };
}

// 预注册 updateUsageStatistics，避免后端返回状态早于 Settings/UsageStatisticsSection 初始化
if (typeof window !== 'undefined' && !window.updateUsageStatistics) {
  console.log('[Main] Pre-registering updateUsageStatistics placeholder');
  window.updateUsageStatistics = (json: string) => {
    console.log('[Main] Storing pending usage statistics, length=' + (json ? json.length : 0));
    window.__pendingUsageStatistics = json;
  };
}

if (typeof window !== 'undefined' && !window.showPermissionDialog) {
  console.log('[Main] Pre-registering showPermissionDialog placeholder');
  window.showPermissionDialog = (json: string) => {
    const pending = window.__pendingPermissionDialogRequests || [];
    pending.push(json);
    window.__pendingPermissionDialogRequests = pending;
  };
}

if (typeof window !== 'undefined' && !window.showAskUserQuestionDialog) {
  console.log('[Main] Pre-registering showAskUserQuestionDialog placeholder');
  window.showAskUserQuestionDialog = (json: string) => {
    const pending = window.__pendingAskUserQuestionDialogRequests || [];
    pending.push(json);
    window.__pendingAskUserQuestionDialogRequests = pending;
  };
}

if (typeof window !== 'undefined' && !window.showPlanApprovalDialog) {
  console.log('[Main] Pre-registering showPlanApprovalDialog placeholder');
  window.showPlanApprovalDialog = (json: string) => {
    const pending = window.__pendingPlanApprovalDialogRequests || [];
    pending.push(json);
    window.__pendingPlanApprovalDialogRequests = pending;
  };
}

// 渲染 React 应用
ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

/**
 * 等待 sendToJava 桥接函数可用
 */
function waitForBridge(callback: () => void, maxAttempts = 50, interval = 100) {
  let attempts = 0;

  const check = () => {
    attempts++;
    if (window.sendToJava) {
      console.log('[Main] Bridge available after ' + attempts + ' attempts');
      callback();
    } else if (attempts < maxAttempts) {
      setTimeout(check, interval);
    } else {
      console.error('[Main] Bridge not available after ' + maxAttempts + ' attempts');
    }
  };

  check();
}

// 等待桥接可用后，初始化斜杠命令
waitForBridge(() => {
  console.log('[Main] Bridge ready, setting up slash commands');
  setupSlashCommandsCallback();
  startBridgeHeartbeat();

  console.log('[Main] Sending frontend_ready signal');
  sendBridgeEvent('frontend_ready');

  console.log('[Main] Sending refresh_slash_commands request');
  sendBridgeEvent('refresh_slash_commands');

  // Ensure SDK dependency status is fetched on initial load (not only after opening Settings).
  console.log('[Main] Requesting dependency status');
  sendBridgeEvent('get_dependency_status');
});

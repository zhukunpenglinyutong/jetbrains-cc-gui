import ReactDOM from 'react-dom/client';
import App from './App';
import './codicon.css';
import './styles/app.less';
import './i18n/config';
import { setupSlashCommandsCallback } from './components/ChatInputBox/providers/slashCommandProvider';
import { sendBridgeEvent } from './utils/bridge';

const enableVConsole =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_VCONSOLE === 'true';

if (enableVConsole) {
  void import('vconsole').then(({ default: VConsole }) => {
    new VConsole();
  });
}

// 预注册 updateSlashCommands，避免后端调用早于 React 初始化
if (typeof window !== 'undefined' && !window.updateSlashCommands) {
  console.log('[Main] Pre-registering updateSlashCommands placeholder');
  window.updateSlashCommands = (json: string) => {
    console.log('[Main] Storing pending slash commands, length=' + json.length);
    window.__pendingSlashCommands = json;
  };
}

// 渲染 React 应用
ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <App />,
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

  console.log('[Main] Sending frontend_ready signal');
  sendBridgeEvent('frontend_ready');

  console.log('[Main] Sending refresh_slash_commands request');
  sendBridgeEvent('refresh_slash_commands');
});

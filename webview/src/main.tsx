import ReactDOM from 'react-dom/client';
import App from './App';
import './codicon.css';
import './styles/app.less';
import './i18n/config'; // 导入 i18n 配置

// 预注册 updateSlashCommands，避免后端调用早于 React 初始化
if (typeof window !== 'undefined' && !window.updateSlashCommands) {
  window.updateSlashCommands = (json: string) => {
    window.__pendingSlashCommands = json;
  };
}

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <App />,
);

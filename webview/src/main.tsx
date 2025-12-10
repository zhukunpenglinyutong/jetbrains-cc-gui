import ReactDOM from 'react-dom/client';
import App from './App';
import './codicon.css';
import './styles/app.less';
import './i18n/config'; // 导入 i18n 配置

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <App />,
);


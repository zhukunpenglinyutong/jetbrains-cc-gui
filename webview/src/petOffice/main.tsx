import ReactDOM from 'react-dom/client';
import { OfficePrototype } from './OfficePrototype';
import { LiveOffice } from './LiveOffice';
import i18n from './officeI18n';
import './office.css';

const language = window.__PET_OFFICE_BOOTSTRAP__?.language;
if (language && !localStorage.getItem('language')) void i18n.changeLanguage(language);
const root = document.getElementById('office-root');
if (!root) throw new Error('Office root is missing');
ReactDOM.createRoot(root).render(window.__PET_OFFICE_BOOTSTRAP__?.mode === 'live' ? <LiveOffice /> : <OfficePrototype />);

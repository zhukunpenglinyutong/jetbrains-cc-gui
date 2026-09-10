import { useTranslation } from 'react-i18next';
import type { EnvVarEntry } from '../../types/provider';
import EnvVarEditor from '../EnvVarEditor';

interface EnvVarsSectionProps {
  messageEnvVars: EnvVarEntry[];
  mcpEnvVars: EnvVarEntry[];
  onMessageEnvVarsChange: (entries: EnvVarEntry[]) => void;
  onMcpEnvVarsChange: (entries: EnvVarEntry[]) => void;
}

export default function EnvVarsSection({
  messageEnvVars,
  mcpEnvVars,
  onMessageEnvVarsChange,
  onMcpEnvVarsChange,
}: EnvVarsSectionProps) {
  const { t } = useTranslation();

  return (
    <details className="advanced-section">
      <summary className="advanced-toggle">
        <span className="codicon codicon-chevron-right" />
        {t('settings.codexProvider.dialog.envVarsTitle')}
      </summary>

      {/* Message Environment Variables */}
      <div className="form-group" style={{ marginTop: '16px' }}>
        <label>{t('settings.codexProvider.dialog.messageEnvLabel')}</label>
        <small className="form-hint">{t('settings.codexProvider.dialog.messageEnvHint')}</small>
        <EnvVarEditor
          entries={messageEnvVars}
          onChange={onMessageEnvVarsChange}
        />
      </div>

      {/* MCP Environment Variables */}
      <div className="form-group">
        <label>{t('settings.codexProvider.dialog.mcpEnvLabel')}</label>
        <small className="form-hint">{t('settings.codexProvider.dialog.mcpEnvHint')}</small>
        <EnvVarEditor
          entries={mcpEnvVars}
          onChange={onMcpEnvVarsChange}
        />
      </div>
    </details>
  );
}

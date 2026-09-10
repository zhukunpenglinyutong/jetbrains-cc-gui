import { useTranslation } from 'react-i18next';

const SECTION_DESC_STYLE: React.CSSProperties = { marginBottom: '12px', fontSize: '12px', color: '#999' };

interface JsonConfigSectionProps {
  jsonConfig: string;
  jsonError: string;
  onJsonChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onFormatJson: () => void;
}

export default function JsonConfigSection({
  jsonConfig,
  jsonError,
  onJsonChange,
  onFormatJson,
}: JsonConfigSectionProps) {
  const { t } = useTranslation();

  return (
    <details className="advanced-section" open>
      <summary className="advanced-toggle">
        <span className="codicon codicon-chevron-right" />
        {t('settings.provider.dialog.jsonConfig')}
      </summary>
      <div className="json-config-section">
        <p className="section-desc" style={SECTION_DESC_STYLE}>
          {t('settings.provider.dialog.jsonConfigDescription')}
        </p>

        {/* Toolbar */}
        <div className="json-toolbar">
          <button
            type="button"
            className="format-btn"
            onClick={onFormatJson}
            title={t('settings.provider.dialog.formatJson') || '格式化 JSON'}
          >
            <span className="codicon codicon-symbol-keyword" />
            {t('settings.provider.dialog.formatJson') || '格式化'}
          </button>
        </div>

        <div className="json-editor-wrapper">
          <textarea
            className="json-editor"
            value={jsonConfig}
            onChange={onJsonChange}
            placeholder={`{
  "env": {
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_MODEL": "",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": ""
  },
  "model": "sonnet",
  "alwaysThinkingEnabled": true,
  "ccSwitchProviderId": "default",
  "codemossProviderId": ""
}`}
          />
          {jsonError && (
            <p className="json-error">
              <span className="codicon codicon-error" />
              {jsonError}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

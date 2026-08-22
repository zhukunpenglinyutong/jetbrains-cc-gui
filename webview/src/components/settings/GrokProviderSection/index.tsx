import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

export type GrokAuthMethod = 'oauth' | 'api_key' | 'auto';

const PLACEHOLDER_JSON = `{
  "env": {
    "XAI_API_KEY": "",
    "GROK_API_KEY": "",
    "GROK_MODELS_BASE_URL": "",
    "GROK_CLI_CHAT_PROXY_BASE_URL": ""
  },
  "authMethod": "oauth"
}`;

const GrokProviderSection = () => {
  const { t } = useTranslation();
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handler = (jsonStr: string) => {
      try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        // XAI_API_KEY is the official xAI env; GROK_API_KEY is a compatible alias.
        // Runtime accepts either (and usually writes both when injecting a key).
        const apiKey = data?.apiKey || '';
        const configObj = {
          env: data?.env || {
            XAI_API_KEY: apiKey,
            GROK_API_KEY: apiKey,
            GROK_MODELS_BASE_URL: data?.apiBaseUrl || '',
            GROK_CLI_CHAT_PROXY_BASE_URL: data?.oauthBaseUrl || '',
          },
          authMethod: data?.authMethod || 'oauth'
        };
        setJsonConfig(JSON.stringify(configObj, null, 2));
      } catch {
        // ignore parse errors
      }
    };
    window.updateGrokAuthConfig = handler;
    window.sendToJava?.('get_grok_auth_config:');
    return () => {
      if (window.updateGrokAuthConfig === handler) {
        delete window.updateGrokAuthConfig;
      }
    };
  }, []);

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonConfig(e.target.value);
    setJsonError('');
  };

  const handleSave = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonConfig);
      const env = parsed.env || {};
      const next = {
        authMethod: parsed.authMethod || 'oauth',
        apiKey: env.XAI_API_KEY || env.GROK_API_KEY || '',
        apiBaseUrl: env.GROK_MODELS_BASE_URL || '',
        oauthBaseUrl: env.GROK_CLI_CHAT_PROXY_BASE_URL || '',
        env: env // send custom env down to backend
      };

      setSaving(true);
      window.sendToJava?.(`set_grok_auth_config:${JSON.stringify(next)}`);
      setTimeout(() => setSaving(false), 400);
      setJsonError('');
    } catch {
      setJsonError(t('settings.grok.invalidJson'));
    }
  }, [jsonConfig, t]);

  return (
    <div className={styles.grokSection}>
      <div className={styles.header}>
        <h4 className={styles.title}>{t('settings.grok.title')}</h4>
        <p className={styles.desc}>{t('settings.grok.desc')}</p>
      </div>

      <div className={styles.card}>
        <div className={styles.cardBody}>
          <div className={styles.editorHint}>{t('settings.grok.editorHint')}</div>
          <textarea
            className={styles.editorTextarea}
            value={jsonConfig}
            onChange={handleJsonChange}
            placeholder={PLACEHOLDER_JSON}
            spellCheck={false}
          />
          {jsonError && (
            <p className={styles.editorError}>
              <span className="codicon codicon-error" />
              {jsonError}
            </p>
          )}

          <div className={styles.saveRow}>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? t('settings.grok.saving') : t('settings.grok.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GrokProviderSection;

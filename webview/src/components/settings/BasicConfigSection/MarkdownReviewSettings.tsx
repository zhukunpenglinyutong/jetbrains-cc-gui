import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ToggleSettingSection } from './ToggleSettingSection';
import styles from './style.module.less';

interface ReviewConfig { enabled: boolean; autoAddToChat: boolean; autoDeleteAffected: boolean; persist: boolean; submitShortcut: 'enter' | 'ctrlEnter' }
const defaults: ReviewConfig = { enabled: false, autoAddToChat: false, autoDeleteAffected: true, persist: false, submitShortcut: 'enter' };

export function MarkdownReviewSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(defaults);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const receive = (raw: string) => {
      try {
        const data = JSON.parse(raw);
        if (['enabled', 'autoAddToChat', 'autoDeleteAffected', 'persist'].some(key => typeof data[key] !== 'boolean')) return;
        const submitShortcut = data.submitShortcut ?? 'enter';
        if (submitShortcut !== 'enter' && submitShortcut !== 'ctrlEnter') return;
        setConfig({ enabled: data.enabled, autoAddToChat: data.autoAddToChat, autoDeleteAffected: data.autoDeleteAffected, persist: data.persist, submitShortcut });
        setError(Boolean(data.error));
        setPending(false);
      } catch { setError(true); setPending(false); }
    };
    window.setMarkdownReviewConfig = receive;
    window.sendToJava?.('get_markdown_review_config:');
    return () => {
      if (window.setMarkdownReviewConfig === receive) delete window.setMarkdownReviewConfig;
    };
  }, []);

  const change = (key: keyof ReviewConfig, value: boolean | ReviewConfig['submitShortcut']) => {
    if (!window.sendToJava) { setError(true); return; }
    setPending(true);
    setError(false);
    window.sendToJava('set_markdown_review_config:' + JSON.stringify({ [key]: value }));
  };

  return <section aria-label={t('markdownReview.settings.title')}>
    {(['enabled', 'autoAddToChat', 'autoDeleteAffected', 'persist'] as const).map(key => <ToggleSettingSection
      key={key}
      icon={key === 'persist' ? 'codicon-save' : 'codicon-comment'}
      label={t(`markdownReview.settings.${key}.label`)}
      ariaLabel={t(`markdownReview.settings.${key}.label`)}
      checked={config[key]}
      disabled={pending}
      onChange={value => change(key, value)}
      enabledLabel={t('markdownReview.settings.on')}
      disabledLabel={t('markdownReview.settings.off')}
      hint={t(`markdownReview.settings.${key}.hint`)}
    />)}
    <div className={styles.sendShortcutSection}>
      <label className={styles.fieldHeader} htmlFor="markdown-review-submit-shortcut">
        <span className="codicon codicon-keyboard" aria-hidden="true" />
        <span className={styles.fieldLabel}>{t('markdownReview.settings.submitShortcut.label')}</span>
      </label>
      <select id="markdown-review-submit-shortcut" className={styles.reviewShortcutSelect}
        value={config.submitShortcut} disabled={pending}
        onChange={event => change('submitShortcut', event.target.value as ReviewConfig['submitShortcut'])}>
        <option value="enter">{t('markdownReview.settings.submitShortcut.enter')}</option>
        <option value="ctrlEnter">{t('markdownReview.settings.submitShortcut.ctrlEnter')}</option>
      </select>
      <p className={styles.sectionDesc}>{t('markdownReview.settings.submitShortcut.hint')}</p>
    </div>
    {error && <p role="alert">{t('markdownReview.settings.error')}</p>}
  </section>;
}

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type React from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import AiFeatureSettingsCard from '../AiFeatureSettingsCard';
import styles from './style.module.less';

declare global {
  interface Window {
    updateVoiceInputConfig?: (payload: string) => void;
    onVoiceInputTestResult?: (payload: string) => void;
  }
}

/** What Java reports; the stored API key itself never reaches the webview. */
export interface VoiceInputSettings {
  baseUrl: string;
  model: string;
  language: string;
  liveTranscription: boolean;
  /** Comma-separated words removed from transcripts; empty keeps them as returned. */
  fillerWords: string;
  apiKeySet: boolean;
  apiKeyHint: string;
  /** Keymap binding of the Voice Input action; empty when unbound. */
  shortcut?: string;
}

/** Fields sent on save; each omitted field keeps its stored value, apiKey '' clears the key. */
export interface VoiceInputSettingsUpdate {
  baseUrl?: string;
  model?: string;
  language?: string;
  liveTranscription?: boolean;
  fillerWords?: string;
  apiKey?: string;
}

/** Mirrors VoiceInputConfig.Problem so the page can flag a bad endpoint before anything is sent. */
export type EndpointProblem = 'invalid_endpoint' | 'insecure_endpoint';

interface TestResult {
  ok: boolean;
  latencyMs?: number;
  errorCode?: string;
  error?: string;
}

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'done'; result: TestResult };

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saved' }
  | { kind: 'error'; error: string };

type LoadState = 'loading' | 'loaded' | 'failed';

type TextField = 'baseUrl' | 'model' | 'language' | 'fillerWords';
const TEXT_FIELDS: readonly TextField[] = ['baseUrl', 'model', 'language', 'fillerWords'];

/** Java's reply to a get or set; {@code error} replaces the settings when either failed. */
type ConfigPayload = (VoiceInputSettings | { error: string }) & { requestId?: number };

/** One request to Java, keyed by the id Java echoes in its reply. */
type PendingRequest = { kind: 'load' } | { kind: 'save'; update: VoiceInputSettingsUpdate };

const SWITCH_FIELDS = ['liveTranscription'] as const;

/** Re-request the config once if Java has not answered, then show an error with a retry. */
const LOAD_RETRY_MS = 3000;
const SAVED_BADGE_MS = 2000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** scheme://host[:port][/path] with no query or fragment, as java.net.URI splits it. */
const ENDPOINT_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(\[[0-9A-Fa-f:.]+\]|[^/?#:@\s]+)(?::\d*)?(?:\/[^?#\s]*)?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** RFC 2396 host rules that java.net.URI applies: the last label must start with a letter. */
function isValidHost(host: string): boolean {
  if (host.startsWith('[') || IPV4.test(host)) return true;
  const labels = host.replace(/\.$/, '').split('.');
  return labels.every((label) => LABEL.test(label)) && /^[A-Za-z]/.test(labels[labels.length - 1]);
}

/**
 * Same rule as VoiceInputConfig.problem() in Java: https anywhere, plain http only for this
 * machine, no query or fragment. Empty is not reported here; Java reports it on use.
 */
export function endpointProblem(url: string): EndpointProblem | null {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const match = ENDPOINT_SHAPE.exec(trimmed);
  if (!match) return 'invalid_endpoint';
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  if ((scheme !== 'https' && scheme !== 'http') || !isValidHost(host)) return 'invalid_endpoint';
  return scheme === 'http' && !LOOPBACK_HOSTS.has(host) ? 'insecure_endpoint' : null;
}

interface FieldProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}

/** Label column + control column; stacks on narrow panels. */
const Field = ({ id, label, hint, error, children }: FieldProps) => (
  <div className={styles.field}>
    <label className={styles.fieldLabel} htmlFor={id}>{label}</label>
    <div className={styles.fieldControl}>{children}</div>
    {(error || hint) && (
      <p className={error ? styles.fieldError : styles.fieldHint} id={`${id}-hint`}>
        {error || hint}
      </p>
    )}
  </div>
);

interface SwitchRowProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

const SwitchRow = ({ id, label, description, checked, disabled, onChange }: SwitchRowProps) => (
  <div className={styles.switchRow}>
    <div className={styles.switchText}>
      <span className={styles.switchLabel} id={`${id}-label`}>{label}</span>
      <span className={styles.switchDescription} id={`${id}-description`}>{description}</span>
    </div>
    <button
      type="button"
      role="switch"
      className={styles.switch}
      aria-checked={checked}
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-description`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  </div>
);

/** Renders "Ctrl+Shift+." as separate key caps; symbol-only bindings (macOS "⇧⌘.") stay one cap. */
const ShortcutKeys = ({ shortcut }: { shortcut: string }) => {
  const keys = shortcut.length > 1 && shortcut.includes('+') && !shortcut.endsWith('+')
    ? shortcut.split('+')
    : [shortcut];
  return (
    <span className={styles.keys}>
      {keys.map((key, index) => (
        <span key={`${key}-${index}`} className={styles.keyGroup}>
          {index > 0 && <span className={styles.keyJoin} aria-hidden="true">+</span>}
          <kbd className={styles.kbd}>{key}</kbd>
        </span>
      ))}
    </span>
  );
};

/** Every field saves on its own: text fields on blur or Enter, switches on change. */
const VoiceInputSection = () => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<VoiceInputSettings | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState('');
  const [fillerWords, setFillerWords] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const pendingRef = useRef(new Map<number, PendingRequest>());
  const nextRequestIdRef = useRef(1);
  /** Last values Java confirmed, without optimistic switch flips; a failed save reverts to these. */
  const storedRef = useRef<VoiceInputSettings | null>(null);
  const loadedRef = useRef(false);
  /** Values sent but not yet echoed, so Enter followed by blur saves once. */
  const submittedRef = useRef<Partial<Record<TextField, string>>>({});

  const setTextField = (field: TextField, value: string) => {
    if (field === 'baseUrl') setBaseUrl(value);
    else if (field === 'model') setModel(value);
    else if (field === 'language') setLanguage(value);
    else setFillerWords(value);
  };

  const applyConfig = useEffectEvent((payload: string) => {
    let next: ConfigPayload;
    try {
      next = JSON.parse(payload) as ConfigPayload;
    } catch {
      return;
    }
    const id = next.requestId;
    const request: PendingRequest = (id !== undefined ? pendingRef.current.get(id) : undefined) ?? { kind: 'load' };
    if (id !== undefined) pendingRef.current.delete(id);
    if ('error' in next) {
      if (request.kind === 'save') {
        // Let the same value be submitted again, and show switches as they are actually stored.
        TEXT_FIELDS.forEach((field) => delete submittedRef.current[field]);
        const stored = storedRef.current;
        if (stored) {
          setSettings((current) => (current ? { ...current, liveTranscription: stored.liveTranscription } : current));
        }
        setSaveStatus({ kind: 'error', error: next.error });
      } else if (!loadedRef.current) {
        setLoadState('failed');
        setLoadError(next.error);
      }
      return;
    }
    const firstLoad = !loadedRef.current;
    loadedRef.current = true;
    storedRef.current = next;
    setLoadState('loaded');
    // Switches flipped since this request still have saves in flight; keep showing their new value.
    const shown = { ...next };
    for (const later of pendingRef.current.values()) {
      if (later.kind !== 'save') continue;
      for (const field of SWITCH_FIELDS) {
        const value = later.update[field];
        if (value !== undefined) shown[field] = value;
      }
    }
    setSettings(shown);
    if (request.kind === 'load') {
      // Only the first load fills the form; a late duplicate (retry) must not wipe typing.
      if (firstLoad) {
        TEXT_FIELDS.forEach((field) => setTextField(field, next[field]));
        setApiKey('');
        submittedRef.current = {};
      }
      return;
    }
    const saved = Object.keys(request.update);
    TEXT_FIELDS
      .filter((field) => saved.includes(field))
      .forEach((field) => {
        setTextField(field, next[field]);
        if (submittedRef.current[field] === request.update[field]) delete submittedRef.current[field];
      });
    if (saved.includes('apiKey')) {
      setApiKey('');
    }
    setSaveStatus({ kind: 'saved' });
  });

  const applyTestResult = useEffectEvent((payload: string) => {
    try {
      setTestStatus({ kind: 'done', result: JSON.parse(payload) as TestResult });
    } catch {
      setTestStatus({ kind: 'idle' });
    }
  });

  const sendRequest = (type: string, request: PendingRequest, body: Record<string, unknown> = {}) => {
    if (!window.sendToJava) return;
    const requestId = nextRequestIdRef.current++;
    pendingRef.current.set(requestId, request);
    window.sendToJava(`${type}:${JSON.stringify({ ...body, requestId })}`);
  };

  const requestConfig = () => sendRequest('voice_input_get_config', { kind: 'load' });

  // Subscribe once: re-requesting on every render would overwrite fields mid-edit. Only remove
  // the callbacks we installed, in case a newer mount already replaced them.
  useEffect(() => {
    const onConfig = (payload: string) => applyConfig(payload);
    const onTest = (payload: string) => applyTestResult(payload);
    window.updateVoiceInputConfig = onConfig;
    window.onVoiceInputTestResult = onTest;
    requestConfig();
    const retry = window.setTimeout(() => {
      if (!loadedRef.current) requestConfig();
    }, LOAD_RETRY_MS);
    const giveUp = window.setTimeout(() => {
      if (!loadedRef.current) setLoadState('failed');
    }, LOAD_RETRY_MS * 2);
    return () => {
      window.clearTimeout(retry);
      window.clearTimeout(giveUp);
      if (window.updateVoiceInputConfig === onConfig) delete window.updateVoiceInputConfig;
      if (window.onVoiceInputTestResult === onTest) delete window.onVoiceInputTestResult;
    };
  }, []);

  useEffect(() => {
    if (saveStatus.kind !== 'saved') return undefined;
    const hide = window.setTimeout(() => setSaveStatus({ kind: 'idle' }), SAVED_BADGE_MS);
    return () => window.clearTimeout(hide);
  }, [saveStatus]);

  const save = (update: VoiceInputSettingsUpdate) => sendRequest('voice_input_set_config', { kind: 'save', update }, { ...update });

  const commitText = (field: TextField, value: string) => {
    const trimmed = value.trim();
    if (!settings || trimmed === (submittedRef.current[field] ?? settings[field])) return;
    submittedRef.current[field] = trimmed;
    save({ [field]: trimmed });
  };

  const commitApiKey = () => {
    if (apiKey.trim()) save({ apiKey: apiKey.trim() });
  };

  const textInputProps = (field: TextField, value: string, setValue: (value: string) => void) => ({
    id: `voice-input-${field}`,
    className: styles.input,
    value,
    spellCheck: false,
    disabled: !settings,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => commitText(field, e.target.value),
    // Enter commits without waiting for focus to leave the field.
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commitText(field, e.currentTarget.value);
    },
  });

  const toggle = (field: 'liveTranscription', value: boolean) => {
    setSettings((current) => (current ? { ...current, [field]: value } : current));
    save({ [field]: value });
  };

  const handleTest = () => {
    setTestStatus({ kind: 'testing' });
    const update: VoiceInputSettingsUpdate = { baseUrl, model, language };
    if (apiKey.trim()) update.apiKey = apiKey.trim();
    window.sendToJava?.(`voice_input_test_config:${JSON.stringify(update)}`);
  };

  const handleRetryLoad = () => {
    setLoadState('loading');
    requestConfig();
  };

  const baseUrlProblem = endpointProblem(baseUrl);
  const testFailed = testStatus.kind === 'done' && !testStatus.result.ok;
  const testMessage = testStatus.kind === 'testing'
    ? t('settings.voiceInput.test.testing')
    : testStatus.kind === 'done'
      ? testStatus.result.ok
        ? t('settings.voiceInput.test.ok', { ms: testStatus.result.latencyMs ?? 0 })
        : testStatus.result.errorCode
          ? t(`voiceInput.error.${testStatus.result.errorCode}`)
          : t('settings.voiceInput.test.failed', { error: testStatus.result.error ?? '' })
      : '';

  return (
    <div className={styles.configSection}>
      <AiFeatureSettingsCard
        title={t('settings.voiceInput.title')}
        description={t('settings.voiceInput.description')}
        testId="voice-input-settings-card"
      >
        {loadState !== 'loaded' && (
          <div className={styles.loadBanner} data-testid="voice-input-load-state">
            {loadState === 'loading'
              ? <><span className="codicon codicon-loading codicon-modifier-spin" /> {t('settings.voiceInput.loading')}</>
              : (
                <>
                  <span className={styles.errorText}>
                    {t('settings.voiceInput.loadFailed', { error: loadError || t('settings.voiceInput.noResponse') })}
                  </span>
                  <button type="button" className={styles.button} onClick={handleRetryLoad}>
                    {t('settings.voiceInput.retry')}
                  </button>
                </>
              )}
          </div>
        )}

        <section className={styles.group} aria-labelledby="voice-input-service-title">
          <div className={styles.groupHeader}>
            <h4 className={styles.groupTitle} id="voice-input-service-title">{t('settings.voiceInput.service.title')}</h4>
            {saveStatus.kind !== 'idle' && (
              <span
                className={saveStatus.kind === 'error' ? styles.errorText : styles.savedBadge}
                data-testid="voice-input-save-status"
              >
                {saveStatus.kind === 'saved'
                  ? <><span className="codicon codicon-check" /> {t('settings.voiceInput.savedInline')}</>
                  : t('settings.voiceInput.saveFailed', { error: saveStatus.error })}
              </span>
            )}
          </div>

          <Field
            id="voice-input-baseUrl"
            label={t('settings.voiceInput.baseUrl.label')}
            hint={t('settings.voiceInput.baseUrl.hint')}
            error={baseUrlProblem ? t(`voiceInput.error.${baseUrlProblem}`) : null}
          >
            <input
              {...textInputProps('baseUrl', baseUrl, setBaseUrl)}
              className={baseUrlProblem ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="url"
              inputMode="url"
              placeholder={t('settings.voiceInput.baseUrl.placeholder')}
              aria-invalid={baseUrlProblem !== null}
              aria-describedby="voice-input-baseUrl-hint"
            />
          </Field>

          <Field id="voice-input-apiKey" label={t('settings.voiceInput.apiKey.label')} hint={t('settings.voiceInput.apiKey.hint')}>
            <input
              id="voice-input-apiKey"
              type="password"
              autoComplete="off"
              className={styles.input}
              value={apiKey}
              placeholder={settings?.apiKeySet
                ? t('settings.voiceInput.apiKey.placeholderSaved', { hint: settings.apiKeyHint })
                : t('settings.voiceInput.apiKey.placeholderNone')}
              disabled={!settings}
              aria-describedby="voice-input-apiKey-hint"
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={commitApiKey}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitApiKey();
                }
              }}
            />
            {settings?.apiKeySet && (
              <button type="button" className={styles.button} onClick={() => save({ apiKey: '' })}>
                {t('settings.voiceInput.apiKey.clear')}
              </button>
            )}
          </Field>

          <Field id="voice-input-model" label={t('settings.voiceInput.model.label')} hint={t('settings.voiceInput.model.hint')}>
            <input
              {...textInputProps('model', model, setModel)}
              placeholder={t('settings.voiceInput.model.placeholder')}
              aria-describedby="voice-input-model-hint"
            />
          </Field>

          <Field id="voice-input-language" label={t('settings.voiceInput.language.label')} hint={t('settings.voiceInput.language.hint')}>
            <input
              {...textInputProps('language', language, setLanguage)}
              className={`${styles.input} ${styles.inputShort}`}
              placeholder={t('settings.voiceInput.language.placeholder')}
              maxLength={8}
              aria-describedby="voice-input-language-hint"
            />
          </Field>

          <div className={styles.groupFooter}>
            <button
              type="button"
              className={styles.button}
              onClick={handleTest}
              disabled={!settings || testStatus.kind === 'testing'}
            >
              <span className={`codicon ${testStatus.kind === 'testing' ? 'codicon-loading codicon-modifier-spin' : 'codicon-plug'}`} />
              {t('settings.voiceInput.test.button')}
            </button>
            {testMessage && (
              <span className={testFailed ? styles.errorText : styles.statusText} role="status" data-testid="voice-input-test-status">
                {testStatus.kind === 'done' && testStatus.result.ok && <span className="codicon codicon-pass" />}
                {testMessage}
              </span>
            )}
          </div>
        </section>

        <section className={styles.group} aria-labelledby="voice-input-behavior-title">
          <h4 className={styles.groupTitle} id="voice-input-behavior-title">{t('settings.voiceInput.behavior.title')}</h4>
          <SwitchRow
            id="voice-input-live"
            label={t('settings.voiceInput.live.label')}
            description={t('settings.voiceInput.live.description')}
            checked={settings?.liveTranscription ?? true}
            disabled={!settings}
            onChange={(value) => toggle('liveTranscription', value)}
          />
          <Field
            id="voice-input-fillerWords"
            label={t('settings.voiceInput.fillers.label')}
            hint={t('settings.voiceInput.fillers.hint')}
          >
            <input
              {...textInputProps('fillerWords', fillerWords, setFillerWords)}
              placeholder={t('settings.voiceInput.fillers.placeholder')}
              aria-describedby="voice-input-fillerWords-hint"
            />
          </Field>
        </section>

        <section className={styles.group} aria-labelledby="voice-input-shortcut-title">
          <h4 className={styles.groupTitle} id="voice-input-shortcut-title">{t('settings.voiceInput.shortcut.title')}</h4>
          <div className={`${styles.switchRow} ${styles.shortcutRow}`}>
            <div className={styles.switchText}>
              <span className={styles.switchLabel}>{t('settings.voiceInput.shortcut.label')}</span>
              <span className={styles.switchDescription}>{t('settings.voiceInput.shortcut.hint')}</span>
            </div>
            <div data-testid="voice-input-shortcut">
              {settings?.shortcut
                ? <ShortcutKeys shortcut={settings.shortcut} />
                : <span className={styles.statusText}>{t('settings.voiceInput.shortcut.unbound')}</span>}
            </div>
          </div>
        </section>
      </AiFeatureSettingsCard>
    </div>
  );
};

export default VoiceInputSection;

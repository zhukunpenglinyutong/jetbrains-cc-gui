import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

/**
 * Code-completion (FIM) settings section.
 *
 * Self-contained: on mount it asks the backend for the current config and
 * registers the window callbacks (restoring previous handlers on unmount).
 *
 * Only platforms verified to expose a real FIM/completions endpoint are
 * offered as presets; anything else goes through "Custom".
 */

export interface CodeCompletionConfig {
  enabled: boolean;
  preset: 'deepseek' | 'siliconflow' | 'custom';
  baseUrl: string;
  path: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  stop: string[];
  ignoreEos: boolean;
  debounceMs: number;
}

interface Preset {
  id: CodeCompletionConfig['preset'];
  label: string;
  baseUrl: string;
  path: string;
  models: string[];
}

/**
 * Verified against the live APIs: DeepSeek official /beta/completions and
 * SiliconFlow /v1/completions both return a real FIM fragment for the models
 * listed below. Platforms without a completions endpoint (Ark, MiniMax, Kimi,
 * GLM, Claude, OpenCode Zen) are deliberately absent.
 *
 * Only models that answered a real `prompt` + `suffix` call with 200 and a
 * usable middle fragment may be listed — a model being *offered* by the
 * gateway says nothing about FIM support, and the gateway rejects the rest at
 * request time with `400 20031 FIM is not supported for this model` (see the
 * 2026-09-18 probe in docs/plans/2026-09-18-code-completion-fim-models.md).
 */
export const PRESETS: Preset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    path: '/beta/completions',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn',
    path: '/v1/completions',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen3-Coder-30B-A3B-Instruct',
      'Pro/deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
    ],
  },
  { id: 'custom', label: 'Custom', baseUrl: '', path: '/v1/completions', models: [] },
];

export const DEFAULT_CODE_COMPLETION_CONFIG: CodeCompletionConfig = {
  enabled: false,
  preset: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  path: '/beta/completions',
  apiKey: '',
  model: 'deepseek-flash',
  maxTokens: 256,
  temperature: 1.0,
  topP: 1.0,
  stop: ['\n\n'],
  ignoreEos: false,
  debounceMs: 300,
};

interface TestResult {
  ok: boolean;
  httpStatus?: number;
  snippet?: string;
  error?: string;
  endpoint?: string;
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Gateway errors that mean "this model cannot do FIM" rather than "your
 * configuration is wrong": SiliconFlow answers `20031 FIM is not supported for
 * this model`, and `20015 suffix is not allowed` when a model refuses the
 * suffix half of FIM. Both are indistinguishable from a broken setup in the
 * raw body, so they get their own explanation.
 */
const FIM_UNSUPPORTED_ERROR = /20031|FIM is not supported|suffix is not allowed/i;

function isFimUnsupported(error: unknown): boolean {
  return typeof error === 'string' && FIM_UNSUPPORTED_ERROR.test(error);
}

function toConfig(json: string): { config: CodeCompletionConfig; resolvedFrom: string } {
  let data: any = {};
  try {
    data = JSON.parse(json || '{}');
  } catch {
    data = {};
  }
  const base = DEFAULT_CODE_COMPLETION_CONFIG;
  const preset: CodeCompletionConfig['preset'] =
    data.preset === 'siliconflow' || data.preset === 'custom' ? data.preset : 'deepseek';
  return {
    resolvedFrom: typeof data.apiKeyResolvedFrom === 'string' ? data.apiKeyResolvedFrom : '',
    config: {
      enabled: toBoolean(data.enabled, base.enabled),
      preset,
      baseUrl: typeof data.baseUrl === 'string' && data.baseUrl ? data.baseUrl : base.baseUrl,
      path: typeof data.path === 'string' && data.path ? data.path : base.path,
      apiKey: typeof data.apiKey === 'string' ? data.apiKey : base.apiKey,
      model: typeof data.model === 'string' && data.model ? data.model : base.model,
      maxTokens: toNumber(data.maxTokens, base.maxTokens),
      temperature: toNumber(data.temperature, base.temperature),
      topP: toNumber(data.topP, base.topP),
      stop: Array.isArray(data.stop) ? data.stop.map(String) : base.stop,
      ignoreEos: toBoolean(data.ignoreEos, base.ignoreEos),
      debounceMs: toNumber(data.debounceMs, base.debounceMs),
    },
  };
}

const CodeCompletionSection = () => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CodeCompletionConfig>(DEFAULT_CODE_COMPLETION_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [resolvedFrom, setResolvedFrom] = useState('');
  const prevSettingsCallback = useRef<((json: string) => void) | undefined>(undefined);
  const prevTestCallback = useRef<((json: string) => void) | undefined>(undefined);

  useEffect(() => {
    window.sendToJava?.('get_code_completion_settings:');
  }, []);

  useEffect(() => {
    prevSettingsCallback.current = window.updateCodeCompletionSettings;
    window.updateCodeCompletionSettings = (json: string) => {
      const parsed = toConfig(json);
      setDraft(parsed.config);
      setResolvedFrom(parsed.resolvedFrom);
      setLoaded(true);
    };
    prevTestCallback.current = window.onCodeCompletionTestResult;
    window.onCodeCompletionTestResult = (json: string) => {
      try {
        const parsed = JSON.parse(json || '{}') as TestResult & { apiKeyResolvedFrom?: string };
        setTestResult(parsed);
        // The probe resolved a credential against the tested config; keep the
        // "reused from <provider>" hint in step with it.
        if (typeof parsed.apiKeyResolvedFrom === 'string') {
          setResolvedFrom(parsed.apiKeyResolvedFrom);
        }
      } catch {
        setTestResult({ ok: false, error: 'Malformed test result' });
      }
      setTesting(false);
    };
    return () => {
      window.updateCodeCompletionSettings = prevSettingsCallback.current;
      window.onCodeCompletionTestResult = prevTestCallback.current;
    };
  }, []);

  const set = useCallback(<K extends keyof CodeCompletionConfig>(key: K, value: CodeCompletionConfig[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const applyPreset = useCallback((id: CodeCompletionConfig['preset']) => {
    const p = PRESETS.find((x) => x.id === id);
    setDraft((d) => ({
      ...d,
      preset: id,
      baseUrl: p && p.baseUrl ? p.baseUrl : d.baseUrl,
      path: p && p.path ? p.path : d.path,
      model: p && p.models.length > 0 ? p.models[0] : d.model,
    }));
    setTestResult(null);
  }, []);

  const handleSave = useCallback(() => {
    setSaving(true);
    window.sendToJava?.(`set_code_completion_settings:${JSON.stringify(draft)}`);
    window.setTimeout(() => setSaving(false), 400);
  }, [draft]);

  const handleTest = useCallback(() => {
    setTesting(true);
    setTestResult(null);
    // Test what the form is showing, not what was last saved: the button exists
    // to diagnose the configuration the user is editing, and testing the stored
    // one made a platform switch report another endpoint's result.
    window.sendToJava?.(`test_code_completion:${JSON.stringify(draft)}`);
  }, [draft]);

  const apiKeyStored = draft.apiKey.includes('****');
  const presetModels = PRESETS.find((p) => p.id === draft.preset)?.models ?? [];

  return (
    <div className={styles.section}>
      <h3>{t('settings.codeCompletion.groupTitle')}</h3>
      <p className={styles.description}>{t('settings.codeCompletion.description')}</p>

      <label className={styles.row}>
        <input
          type="checkbox"
          aria-label="enable"
          checked={draft.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
        <span>{t('settings.codeCompletion.enable')}</span>
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.preset')}</span>
        <select
          className={styles.input}
          aria-label="Preset"
          value={draft.preset}
          onChange={(e) => applyPreset(e.target.value as CodeCompletionConfig['preset'])}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.baseUrl')}</span>
        <input
          className={styles.input}
          aria-label="Base URL"
          value={draft.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.path')}</span>
        <input
          className={styles.input}
          aria-label="Endpoint path"
          value={draft.path}
          onChange={(e) => set('path', e.target.value)}
        />
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.apiKey')}</span>
        <input
          type="password"
          className={styles.input}
          aria-label="API Key"
          placeholder={apiKeyStored ? '••••••••' : ''}
          value={draft.apiKey}
          onChange={(e) => set('apiKey', e.target.value)}
        />
      </label>
      {resolvedFrom && (
        <p className={styles.hint}>{t('settings.codeCompletion.reusedFrom', { provider: resolvedFrom })}</p>
      )}
      {apiKeyStored && !resolvedFrom && (
        <p className={styles.hint}>{t('settings.codeCompletion.apiKeyHint')}</p>
      )}

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.model')}</span>
        <input
          className={styles.input}
          aria-label="Model"
          list="code-completion-model-list"
          value={draft.model}
          onChange={(e) => set('model', e.target.value)}
        />
        <datalist id="code-completion-model-list">
          {presetModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.maxTokens')}</span>
        <input
          type="number"
          className={styles.input}
          aria-label="Max Tokens"
          min={1}
          max={8192}
          value={draft.maxTokens}
          onChange={(e) => set('maxTokens', toNumber(e.target.value, DEFAULT_CODE_COMPLETION_CONFIG.maxTokens))}
        />
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.temperature')}</span>
        <input
          type="number"
          step="0.1"
          min={0}
          max={2}
          className={styles.input}
          aria-label="Temperature"
          value={draft.temperature}
          onChange={(e) => set('temperature', toNumber(e.target.value, DEFAULT_CODE_COMPLETION_CONFIG.temperature))}
        />
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.topP')}</span>
        <input
          type="number"
          step="0.05"
          min={0}
          max={1}
          className={styles.input}
          aria-label="Top P"
          value={draft.topP}
          onChange={(e) => set('topP', toNumber(e.target.value, DEFAULT_CODE_COMPLETION_CONFIG.topP))}
        />
      </label>

      <label className={styles.row}>
        <input
          type="checkbox"
          aria-label="Ignore EOS"
          checked={draft.ignoreEos}
          onChange={(e) => set('ignoreEos', e.target.checked)}
        />
        <span>{t('settings.codeCompletion.ignoreEos')}</span>
      </label>

      {!loaded && <p className={styles.hint}>{t('settings.codeCompletion.loading')}</p>}

      <div className={styles.actions}>
        <button className={styles.saveButton} onClick={handleSave} disabled={saving}>
          {t('settings.codeCompletion.save')}
        </button>
        <button
          className={styles.testButton}
          data-testid="code-completion-test"
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? t('settings.codeCompletion.testing') : t('settings.codeCompletion.test')}
        </button>
      </div>

      {testResult && (
        <div
          className={testResult.ok ? styles.testOk : styles.testFail}
          data-testid="code-completion-test-result"
        >
          <div>
            {testResult.ok
              ? t('settings.codeCompletion.testOk', { status: testResult.httpStatus })
              : t('settings.codeCompletion.testFail', { error: testResult.error ?? '' })}
          </div>
          {testResult.endpoint && <div className={styles.hint}>{testResult.endpoint}</div>}
          {testResult.snippet && <pre className={styles.snippet}>{testResult.snippet}</pre>}
          {!testResult.ok && isFimUnsupported(testResult.error) && (
            <div className={styles.hint} data-testid="code-completion-fim-hint">
              {presetModels.length > 0
                ? t('settings.codeCompletion.fimUnsupported', { models: presetModels.join(', ') })
                : t('settings.codeCompletion.fimUnsupportedCustom')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CodeCompletionSection;

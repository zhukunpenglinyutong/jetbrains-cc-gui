import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig, EnvVarEntry } from '../../types/provider';
import {
  CODEX_PROVIDER_PRESETS,
  DEFAULT_CODEX_AUTH_JSON,
  ENV_VAR_VALUE_MAX_LENGTH,
  OFFICIAL_CODEX_CONFIG_TOML,
  OFFICIAL_CODEX_PROVIDER_NAME,
  validateEnvVarEntries,
} from '../../types/provider';
import { OFFICIAL_DIRECT_PRESET_ID } from './PresetSections';

interface UseCodexProviderFormOptions {
  isOpen: boolean;
  provider?: CodexProviderConfig | null;
  onSave: (provider: CodexProviderConfig) => void;
  onClose: () => void;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const getEnvVarIssueReasonKey = (reason: string): string | null => {
  switch (reason) {
    case 'invalid':
      return 'settings.codexProvider.dialog.envKeyInvalid';
    case 'protected':
      return 'settings.codexProvider.dialog.envKeyProtected';
    case 'duplicate':
      return 'settings.codexProvider.dialog.envKeyDuplicate';
    case 'value_too_long':
      return 'settings.codexProvider.dialog.envValueTooLong';
    default:
      return null;
  }
};

export function useCodexProviderForm({
  isOpen,
  provider,
  onSave,
  onClose,
  addToast,
}: UseCodexProviderFormOptions) {
  const { t } = useTranslation();

  const [providerName, setProviderName] = useState('');
  const [configTomlJson, setConfigTomlJson] = useState('');
  const [authJson, setAuthJson] = useState('');
  const [messageEnvVars, setMessageEnvVars] = useState<EnvVarEntry[]>([]);
  const [mcpEnvVars, setMcpEnvVars] = useState<EnvVarEntry[]>([]);
  const [activePreset, setActivePreset] = useState('custom');

  // Initialize form
  useEffect(() => {
    if (isOpen) {
      if (provider) {
        // Edit mode - load existing data
        setProviderName(provider.name || '');
        setConfigTomlJson(provider.configToml || '');
        setAuthJson(provider.authJson || '');
        setMessageEnvVars(provider.messageEnvVars || []);
        setMcpEnvVars(provider.mcpEnvVars || []);
        setActivePreset('custom');
      } else {
        // Add mode - reset with default template
        setProviderName(OFFICIAL_CODEX_PROVIDER_NAME);
        setConfigTomlJson(OFFICIAL_CODEX_CONFIG_TOML);
        setAuthJson(DEFAULT_CODEX_AUTH_JSON);
        setMessageEnvVars([]);
        setMcpEnvVars([]);
        setActivePreset(OFFICIAL_DIRECT_PRESET_ID);
      }
    }
  }, [isOpen, provider]);

  const handlePresetClick = (presetId: string) => {
    if (presetId === OFFICIAL_DIRECT_PRESET_ID) {
      setActivePreset(OFFICIAL_DIRECT_PRESET_ID);
      setProviderName(OFFICIAL_CODEX_PROVIDER_NAME);
      setConfigTomlJson(OFFICIAL_CODEX_CONFIG_TOML);
      setAuthJson(DEFAULT_CODEX_AUTH_JSON);
      return;
    }

    const preset = CODEX_PROVIDER_PRESETS.find(item => item.id === presetId);
    if (!preset) return;

    setActivePreset(preset.id);
    setProviderName(preset.name);
    setConfigTomlJson(preset.configToml);
    setAuthJson(preset.authJson);
  };

  // Format JSON
  const handleFormatConfigJson = () => {
    try {
      const parsed = JSON.parse(configTomlJson);
      setConfigTomlJson(JSON.stringify(parsed, null, 2));
      addToast(t('settings.codexProvider.dialog.formatSuccess'), 'success');
    } catch (e) {
      addToast(t('settings.codexProvider.dialog.formatError'), 'error');
    }
  };

  const handleFormatAuthJson = () => {
    try {
      const parsed = JSON.parse(authJson);
      setAuthJson(JSON.stringify(parsed, null, 2));
      addToast(t('settings.codexProvider.dialog.formatSuccess'), 'success');
    } catch (e) {
      addToast(t('settings.codexProvider.dialog.formatError'), 'error');
    }
  };

  const reportEnvVarIssue = (
    issue: { reason: string; key?: string },
    sectionLabel: string,
  ): boolean => {
    const reasonKey = getEnvVarIssueReasonKey(issue.reason);
    if (!reasonKey) return false;
    addToast(
      `${sectionLabel}: ${t(reasonKey, { key: issue.key, max: ENV_VAR_VALUE_MAX_LENGTH })}`,
      'error',
    );
    return true;
  };

  const handleSave = () => {
    if (!providerName.trim()) {
      addToast(t('settings.codexProvider.dialog.nameRequired'), 'error');
      return;
    }

    // Validate auth.json format (must be valid JSON)
    if (authJson.trim()) {
      try {
        JSON.parse(authJson);
      } catch (e) {
        addToast(t('settings.codexProvider.dialog.authJsonError'), 'error');
        return;
      }
    }

    // Validate env vars before saving
    const messageIssues = validateEnvVarEntries(messageEnvVars);
    if (messageIssues.length > 0) {
      reportEnvVarIssue(messageIssues[0], t('settings.codexProvider.dialog.messageEnvLabel'));
      return;
    }
    const mcpIssues = validateEnvVarEntries(mcpEnvVars);
    if (mcpIssues.length > 0) {
      reportEnvVarIssue(mcpIssues[0], t('settings.codexProvider.dialog.mcpEnvLabel'));
      return;
    }

    const providerData: CodexProviderConfig = {
      id: provider?.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()),
      name: providerName.trim(),
      createdAt: provider?.createdAt,
      configToml: configTomlJson.trim(),
      authJson: authJson.trim(),
      messageEnvVars: messageEnvVars.filter(e => e.key.trim() !== ''),
      mcpEnvVars: mcpEnvVars.filter(e => e.key.trim() !== ''),
    };

    onSave(providerData);
    onClose();
  };

  return {
    providerName,
    setProviderName,
    configTomlJson,
    setConfigTomlJson,
    authJson,
    setAuthJson,
    messageEnvVars,
    setMessageEnvVars,
    mcpEnvVars,
    setMcpEnvVars,
    activePreset,
    handlePresetClick,
    handleFormatConfigJson,
    handleFormatAuthJson,
    handleSave,
  };
}

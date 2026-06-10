/**
 * Language configuration bootstrap module.
 *
 * Applies language settings from the Java backend to the i18n runtime and
 * persists the selection to localStorage.
 */
import i18n from '../i18n/config';
import { debugLog } from '../utils/debug';

/**
 * Apply language configuration to i18n
 * Supports both direct objects (startup injection) and JSON strings (bridge callbacks).
 */
function applyLanguageConfig(rawConfig: { language: string; source?: string; ideaLocale?: string } | string) {
  let config: { language: string; source?: string; ideaLocale?: string };

  if (typeof rawConfig === 'string') {
    try {
      config = JSON.parse(rawConfig) as { language: string; source?: string; ideaLocale?: string };
    } catch (error) {
      console.error('[Main] Failed to parse language config:', error, rawConfig);
      return;
    }
  } else {
    config = rawConfig;
  }

  const { language, source } = config;

  // Validate that the language code is supported
  const supportedLanguages = ['zh', 'en', 'zh-TW', 'hi', 'es', 'fr', 'ja', 'ru', 'ko', 'pt-BR'];
  const targetLanguage = supportedLanguages.includes(language) ? language : 'en';

  debugLog('[Main] Applying language config:', config, 'target language:', targetLanguage, 'source:', source);

  const selectionMode = source === 'user' ? 'manual' : 'followIdea';

  i18n.changeLanguage(targetLanguage)
    .then(() => {
      localStorage.setItem('language', targetLanguage);
      localStorage.setItem('languageSelectionMode', selectionMode);
      // Migrate from legacy 'languageManuallySet' key to 'languageSelectionMode'
      localStorage.removeItem('languageManuallySet');
      // Notify subscribers (e.g. AppearanceTab) of the authoritative config so
      // they can resync even when i18n.language did not change.
      window.dispatchEvent(new CustomEvent('language-config-applied', {
        detail: { language: targetLanguage, selectionMode },
      }));
      debugLog('[Main] Applied language:', targetLanguage, 'source:', source ?? 'idea');
    })
    .catch((error) => {
      console.error('[Main] Failed to change language:', error);
    });
}

/**
 * Register global language config handler and apply any pending config that
 * was delivered by the Java side before JS finished loading.
 */
export function initLanguage() {
  // Register the applyIdeaLanguageConfig function
  window.applyIdeaLanguageConfig = applyLanguageConfig;

  // Check for pending language config (Java side may execute before JS)
  if (window.__pendingLanguageConfig) {
    debugLog('[Main] Found pending language config, applying...');
    applyLanguageConfig(window.__pendingLanguageConfig);
    delete window.__pendingLanguageConfig;
  }
}

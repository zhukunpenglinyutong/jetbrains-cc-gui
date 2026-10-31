import { createInstance, type TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import { createLocalizeMessage } from './localizationUtils';

describe('chat message localization', () => {
  it('leaves ordinary conversation text unchanged without querying error translations', () => {
    const translate = vi.fn((key: string) => key);
    const localize = createLocalizeMessage(translate as unknown as TFunction);
    for (let i = 0; i < 400; i++) {
      const text = `正常开发对话 ${i}: implement the next change`;
      expect(localize(text)).toBe(text);
    }
    expect(translate.mock.calls.length).toBe(0);
  });

  it('keeps exact mappings, embedded errors and repeated diagnostic labels translated', () => {
    const translate = vi.fn((key: string) => `[${key}]`);
    const localize = createLocalizeMessage(translate as unknown as TFunction);
    expect(localize('Not configured (value is empty or missing)')).toBe('[aiBridge.notConfiguredEmpty]');
    expect(localize('Claude Code error: details\n- Error message: detail\n- Error message: again'))
      .toBe('[aiBridge.claudeCodeError] details\n- [aiBridge.errorMessage]: detail\n- [aiBridge.errorMessage]: again');
    expect(localize('API error: unavailable')).toBe('[aiBridge.apiError]: unavailable');
  });

  it('preserves parameter interpolation and follows language changes with the same localizer', async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: 'zh',
      resources: {
        zh: { translation: { aiBridge: { uploadedImages: '上传了 {{count}} 张图片', codexAuthTip: '请配置密钥' } } },
        en: { translation: { aiBridge: { uploadedImages: 'Uploaded {{count}} images', codexAuthTip: 'Configure a key' } } },
      },
    });
    const localize = createLocalizeMessage(i18n.t.bind(i18n));
    expect(localize('[Uploaded 2 image(s)]')).toBe('上传了 2 张图片');
    expect(localize('Tip: Codex requires a valid OpenAI API Key')).toBe('请配置密钥');
    await i18n.changeLanguage('en');
    expect(localize('[Uploaded 2 image(s)]')).toBe('Uploaded 2 images');
    expect(localize('Tip: Codex requires a valid OpenAI API Key')).toBe('Configure a key');
  });
});

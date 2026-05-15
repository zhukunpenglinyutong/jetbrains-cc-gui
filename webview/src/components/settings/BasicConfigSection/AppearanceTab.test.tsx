import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppearanceTab from './AppearanceTab';

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'zh',
      changeLanguage: vi.fn(),
    },
  }),
}));

describe('AppearanceTab ui font selector', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    localStorage.clear();
  });

  it('renders only follow-editor and custom options, plus custom path controls for custom mode', () => {
    const props = {
      theme: 'dark',
      onThemeChange: vi.fn(),
      fontSizeLevel: 3,
      onFontSizeLevelChange: vi.fn(),
      editorFontConfig: {
        fontFamily: 'Monaco',
        fontSize: 14,
        lineSpacing: 1.35,
      },
      uiFontConfig: {
        mode: 'customFile',
        effectiveMode: 'followEditor',
        customFontPath: '/tmp/MapleMono.ttf',
        fontFamily: 'Monaco',
        fontSize: 14,
        lineSpacing: 1.35,
        warning: 'font unavailable, currently using editor font',
      },
      onUiFontSelectionChange: vi.fn(),
      onUiFontCustomPathChange: vi.fn(),
      onSaveUiFontCustomPath: vi.fn(),
      onBrowseUiFontFile: vi.fn(),
    } as any;

    render(<AppearanceTab {...props} />);

    const select = screen.getByRole('combobox', { name: /settings.basic.editorFont.label/i });
    const options = within(select).getAllByRole('option');

    expect(select).toBeTruthy();
    expect(options).toHaveLength(2);
    expect(screen.getByRole('option', { name: /settings.basic.editorFont.followOption/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /settings.basic.editorFont.customOption/i })).toBeTruthy();
    expect(screen.getByDisplayValue('/tmp/MapleMono.ttf')).toBeTruthy();
    expect(screen.getByText(/font unavailable/i)).toBeTruthy();
  });

  it('notifies selection changes immediately for custom font mode', () => {
    const onUiFontSelectionChange = vi.fn();

    render(
      <AppearanceTab
        {...({
          theme: 'dark',
          onThemeChange: vi.fn(),
          fontSizeLevel: 3,
          onFontSizeLevelChange: vi.fn(),
          editorFontConfig: {
            fontFamily: 'Monaco',
            fontSize: 14,
            lineSpacing: 1.35,
          },
          uiFontConfig: {
            mode: 'followEditor',
            effectiveMode: 'followEditor',
            customFontPath: '/tmp/MapleMono.ttf',
            fontFamily: 'Monaco',
            fontSize: 14,
            lineSpacing: 1.35,
          },
          onUiFontSelectionChange,
          onUiFontCustomPathChange: vi.fn(),
          onSaveUiFontCustomPath: vi.fn(),
          onBrowseUiFontFile: vi.fn(),
        } as any)}
      />
    );

    fireEvent.change(screen.getByRole('combobox', { name: /settings.basic.editorFont.label/i }), {
      target: { value: 'customFile' },
    });

    expect(onUiFontSelectionChange).toHaveBeenCalledTimes(1);
    expect(onUiFontSelectionChange).toHaveBeenCalledWith('customFile');
  });

  it('syncs manual UI language changes to the Java backend', () => {
    render(
      <AppearanceTab
        {...({
          theme: 'dark',
          onThemeChange: vi.fn(),
          fontSizeLevel: 3,
          onFontSizeLevelChange: vi.fn(),
        } as any)}
      />
    );

    fireEvent.change(screen.getByDisplayValue('settings.basic.language.simplifiedChinese'), {
      target: { value: 'ja' },
    });

    expect(localStorage.getItem('language')).toBe('ja');
    expect(localStorage.getItem('languageManuallySet')).toBe('true');
    expect(window.sendToJava).toHaveBeenCalledWith('set_ui_language:{"language":"ja"}');
  });
});

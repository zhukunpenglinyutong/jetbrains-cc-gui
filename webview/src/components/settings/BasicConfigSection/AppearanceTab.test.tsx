import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppearanceTab from './AppearanceTab';

const changeLanguageMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'zh',
      changeLanguage: changeLanguageMock,
    },
  }),
}));

describe('AppearanceTab ui font selector', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('clears the manual language override when selecting follow IDE', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    localStorage.setItem('languageSelectionMode', 'manual');

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
            fontFamily: 'Monaco',
            fontSize: 14,
            lineSpacing: 1.35,
          },
          onUiFontSelectionChange: vi.fn(),
          onUiFontCustomPathChange: vi.fn(),
          onSaveUiFontCustomPath: vi.fn(),
          onBrowseUiFontFile: vi.fn(),
        } as any)}
      />
    );

    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: '__follow_idea__' },
    });

    expect(localStorage.getItem('languageSelectionMode')).toBe('followIdea');
    expect(sendToJava).toHaveBeenCalledWith('clear_user_language:');
    expect(changeLanguageMock).not.toHaveBeenCalled();
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
});

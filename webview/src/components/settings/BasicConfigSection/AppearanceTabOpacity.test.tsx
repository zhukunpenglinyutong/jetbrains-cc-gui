import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppearanceTab from './AppearanceTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'zh',
      changeLanguage: vi.fn(),
    },
  }),
}));

function defaultProps(overrides = {}) {
  return {
    theme: 'dark' as const,
    onThemeChange: vi.fn(),
    fontSizeLevel: 3,
    onFontSizeLevelChange: vi.fn(),
    editorFontConfig: {
      fontFamily: 'Monaco',
      fontSize: 14,
      lineSpacing: 1.35,
    },
    uiFontConfig: {
      mode: 'followEditor' as const,
      effectiveMode: 'followEditor' as const,
      customFontPath: '',
      fontFamily: 'Monaco',
      fontSize: 14,
      lineSpacing: 1.35,
    },
    onUiFontSelectionChange: vi.fn(),
    onUiFontCustomPathChange: vi.fn(),
    onSaveUiFontCustomPath: vi.fn(),
    onBrowseUiFontFile: vi.fn(),
    windowOpacity: 1.0,
    onWindowOpacityChange: vi.fn(),
    ...overrides,
  };
}

describe('AppearanceTab windowOpacity', () => {
  const savedPlatform = window.__PLATFORM__;

  beforeEach(() => {
    delete (window as any).__PLATFORM__;
  });

  afterEach(() => {
    (window as any).__PLATFORM__ = savedPlatform;
  });

  it('renders opacity slider when __PLATFORM__ is windows', () => {
    (window as any).__PLATFORM__ = 'windows';
    render(<AppearanceTab {...defaultProps()} />);
    expect(screen.getByRole('slider')).toBeTruthy();
  });

  it('hides opacity slider when __PLATFORM__ is macos', () => {
    (window as any).__PLATFORM__ = 'macos';
    render(<AppearanceTab {...defaultProps()} />);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('hides opacity slider when __PLATFORM__ is linux', () => {
    (window as any).__PLATFORM__ = 'linux';
    render(<AppearanceTab {...defaultProps()} />);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('hides opacity slider when __PLATFORM__ is unknown', () => {
    (window as any).__PLATFORM__ = 'unknown';
    render(<AppearanceTab {...defaultProps()} />);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('hides opacity slider when __PLATFORM__ is undefined (dev environment)', () => {
    render(<AppearanceTab {...defaultProps()} />);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('updates opacity value when slider changes', () => {
    const onWindowOpacityChange = vi.fn();
    (window as any).__PLATFORM__ = 'windows';
    render(<AppearanceTab {...defaultProps({ windowOpacity: 0.7, onWindowOpacityChange })} />);

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '40' } });

    expect(onWindowOpacityChange).toHaveBeenCalledWith(0.4);
  });

  it('calls reset when reset button is clicked', () => {
    const onWindowOpacityChange = vi.fn();
    (window as any).__PLATFORM__ = 'windows';
    render(<AppearanceTab {...defaultProps({ windowOpacity: 0.6, onWindowOpacityChange })} />);

    const resetBtn = screen.getByTitle(/settings.basic.windowOpacity.reset/);
    fireEvent.click(resetBtn);

    expect(onWindowOpacityChange).toHaveBeenCalledWith(1.0);
  });
});

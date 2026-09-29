import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryActions } from './HistoryActions';

// HistoryActions receives `t` as a prop rather than through useTranslation, so the
// translations live here. Unresolvable keys fall through to defaultValue, mirroring
// i18next and exercising the English fallbacks the new keys rely on.
const t = ((key: string, options?: Record<string, unknown>) => {
  const translations: Record<string, string> = {
    'history.convertAllToCliSessions': `Convert all to CLI (${options?.count})`,
    'history.convertAllToCliSessionsTooltip': `Convert ${options?.count} SDK sessions`,
    'history.selectMode': 'Select',
    'history.deepSearchTooltip': 'Deep search',
  };
  return translations[key] ?? (options?.defaultValue as string) ?? key;
}) as unknown as React.ComponentProps<typeof HistoryActions>['t'];

/** Default props for the non-selection-mode toolbar, overridable per test. */
const baseProps = {
  isSelectionMode: false,
  selectedCount: 0,
  visibleCount: 0,
  allVisibleSelected: false,
  isDeepSearching: false,
  t,
};

const renderActions = (overrides: Partial<React.ComponentProps<typeof HistoryActions>> = {}) => {
  const props = {
    ...baseProps,
    isConvertingAll: false,
    convertibleCount: 0,
    onEnterSelectionMode: vi.fn(),
    onExitSelectionMode: vi.fn(),
    onToggleSelectAllVisible: vi.fn(),
    onStartDeleteSelected: vi.fn(),
    onDeepSearch: vi.fn(),
    onConvertAllToCliSessions: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<HistoryActions {...props} />) };
};

// The button's accessible name is the tooltip (aria-label wins over the visible label),
// so at count 0 it is identified by the "nothing to convert" explanation.
const disabledConvertButton = () =>
  screen.getByRole('button', { name: /no sdk or vs code sessions to convert/i }) as HTMLButtonElement;

const enabledConvertButton = () =>
  screen.getByRole('button', { name: /convert 3 sdk sessions/i }) as HTMLButtonElement;

describe('HistoryActions convert-all button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays visible but disabled when there is nothing to convert', () => {
    renderActions({ convertibleCount: 0 });

    // The regression: the button used to unmount entirely at count 0, which made the
    // whole feature undiscoverable for anyone without a matching session in view.
    const button = disabledConvertButton();
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);
  });

  it('explains why it is disabled instead of failing silently', () => {
    renderActions({ convertibleCount: 0 });

    const button = disabledConvertButton();
    // The visible label drops the count; the tooltip and accessible name carry the reason.
    expect(button.textContent).toContain('Convert all to CLI');
    expect(button.getAttribute('title')).toContain('No SDK or VS Code sessions to convert');
  });

  it('is enabled and clickable once convertible sessions exist', () => {
    const { props } = renderActions({ convertibleCount: 3 });

    const button = enabledConvertButton();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Convert all to CLI (3)');
    expect(button.className).toContain('history-toolbar-btn');
    expect(button.querySelector('.codicon-arrow-swap')).toBeTruthy();

    fireEvent.click(button);
    expect(props.onConvertAllToCliSessions).toHaveBeenCalledTimes(1);
  });

  it('does not fire the conversion callback while disabled', () => {
    const { props } = renderActions({ convertibleCount: 0 });

    fireEvent.click(disabledConvertButton());
    expect(props.onConvertAllToCliSessions).not.toHaveBeenCalled();
  });

  it('hides the button in selection mode, where batch actions are already modal', () => {
    renderActions({ convertibleCount: 3, isSelectionMode: true, selectedCount: 1 });

    expect(screen.queryByRole('button', { name: /convert 3 sdk sessions/i })).toBeNull();
  });
});

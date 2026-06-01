// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModeSelect } from './ModeSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('ModeSelect', () => {
  it('shows codex plan mode so it can map to read-only permissions', () => {
    render(<ModeSelect value="default" onChange={vi.fn()} provider="codex" />);

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('modes.plan.label')).toBeTruthy();
  });
});

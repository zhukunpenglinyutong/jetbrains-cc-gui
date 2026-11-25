import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileContextChip } from './FileContextChip';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('FileContextChip placeholder', () => {
  it('toggles the enable popover when the placeholder is clicked again', () => {
    render(<FileContextChip autoOpenFileEnabled={false} />);
    const placeholder = screen.getByRole('button', { name: /fileContext.placeholder/ });

    fireEvent.click(placeholder);
    expect(screen.getByText('fileContext.enableTitle')).toBeTruthy();

    fireEvent.mouseDown(placeholder);
    fireEvent.click(placeholder);
    expect(screen.queryByText('fileContext.enableTitle')).toBeNull();
  });
});

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResizeHandles } from './ResizeHandles.js';

describe('ResizeHandles', () => {
  it('nudges size with keyboard arrows', () => {
    const nudge = vi.fn();
    const getHandleProps = vi.fn(() => ({}));

    const { container } = render(<ResizeHandles getHandleProps={getHandleProps} nudge={nudge} />);

    const handles = container.querySelectorAll('.resize-handle');
    expect(handles.length).toBe(3);

    // n: ArrowUp increases wrapper height
    fireEvent.keyDown(handles[0] as HTMLDivElement, { key: 'ArrowUp' });
    expect(nudge).toHaveBeenCalledWith({ wrapperHeightPx: 8 });

    // e: Shift+ArrowLeft decreases width faster
    fireEvent.keyDown(handles[1] as HTMLDivElement, { key: 'ArrowLeft', shiftKey: true });
    expect(nudge).toHaveBeenCalledWith({ widthPx: -24 });

    // ne: ArrowRight increases width
    fireEvent.keyDown(handles[2] as HTMLDivElement, { key: 'ArrowRight' });
    expect(nudge).toHaveBeenCalledWith({ widthPx: 8 });
  });
});

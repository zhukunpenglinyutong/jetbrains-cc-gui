import type { ComponentPropsWithoutRef, KeyboardEvent as ReactKeyboardEvent } from 'react';

type ResizeDirection = 'n' | 'e' | 'ne';

export function ResizeHandles({
  getHandleProps,
  nudge,
}: {
  getHandleProps: (dir: ResizeDirection) => ComponentPropsWithoutRef<'div'>;
  nudge: (delta: { widthPx?: number; wrapperHeightPx?: number }) => void;
}) {
  const handleKeyDown = (dir: ResizeDirection) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 24 : 8;

    const key = e.key;
    if (
      key !== 'ArrowUp' &&
      key !== 'ArrowDown' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowRight'
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (dir === 'n') {
      if (key === 'ArrowUp') nudge({ wrapperHeightPx: step });
      if (key === 'ArrowDown') nudge({ wrapperHeightPx: -step });
      return;
    }

    if (dir === 'e') {
      if (key === 'ArrowRight') nudge({ widthPx: step });
      if (key === 'ArrowLeft') nudge({ widthPx: -step });
      return;
    }

    // 'ne'
    if (key === 'ArrowUp') nudge({ wrapperHeightPx: step });
    if (key === 'ArrowDown') nudge({ wrapperHeightPx: -step });
    if (key === 'ArrowRight') nudge({ widthPx: step });
    if (key === 'ArrowLeft') nudge({ widthPx: -step });
  };

  return (
    <>
      <div
        className="resize-handle resize-handle--n"
        {...getHandleProps('n')}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize input height"
        tabIndex={0}
        onKeyDown={handleKeyDown('n')}
      />
      <div
        className="resize-handle resize-handle--e"
        {...getHandleProps('e')}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize input width"
        tabIndex={0}
        onKeyDown={handleKeyDown('e')}
      />
      <div
        className="resize-handle resize-handle--ne"
        {...getHandleProps('ne')}
        role="separator"
        aria-label="Resize input size"
        tabIndex={0}
        onKeyDown={handleKeyDown('ne')}
      />
    </>
  );
}

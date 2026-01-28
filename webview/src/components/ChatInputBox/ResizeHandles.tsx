import type { ComponentPropsWithoutRef, KeyboardEvent as ReactKeyboardEvent } from 'react';

type ResizeDirection = 'n';

export function ResizeHandles({
  getHandleProps,
  nudge,
}: {
  getHandleProps: (dir: ResizeDirection) => ComponentPropsWithoutRef<'div'>;
  nudge: (delta: { wrapperHeightPx?: number }) => void;
}) {
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 24 : 8;

    const key = e.key;
    if (key !== 'ArrowUp' && key !== 'ArrowDown') {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (key === 'ArrowUp') nudge({ wrapperHeightPx: step });
    if (key === 'ArrowDown') nudge({ wrapperHeightPx: -step });
  };

  return (
    <div
      className="resize-handle resize-handle--n"
      {...getHandleProps('n')}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize input height"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    />
  );
}

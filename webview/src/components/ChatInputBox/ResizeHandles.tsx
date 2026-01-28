import type { ComponentPropsWithoutRef } from 'react';

type ResizeDirection = 'n' | 'e' | 'ne';

export function ResizeHandles({
  getHandleProps,
}: {
  getHandleProps: (dir: ResizeDirection) => ComponentPropsWithoutRef<'div'>;
}) {
  return (
    <>
      <div
        className="resize-handle resize-handle--n"
        {...getHandleProps('n')}
        aria-label="Resize input height"
      />
      <div
        className="resize-handle resize-handle--e"
        {...getHandleProps('e')}
        aria-label="Resize input width"
      />
      <div
        className="resize-handle resize-handle--ne"
        {...getHandleProps('ne')}
        aria-label="Resize input size"
      />
    </>
  );
}


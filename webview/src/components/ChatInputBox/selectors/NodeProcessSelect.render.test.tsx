import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeProcessSelect } from './NodeProcessSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, string | number>) => {
      if (options && typeof options === 'object' && typeof options.defaultValue === 'string') {
        return options.defaultValue;
      }
      return key;
    },
  }),
}));

vi.mock('../../../utils/nodeProcessCapabilities', () => ({
  fetchNodeProcesses: vi.fn(),
  killAllOrphanProcesses: vi.fn(),
  killNodeProcess: vi.fn(),
  restartNodeDaemon: vi.fn(),
  subscribeNodeProcesses: vi.fn(() => () => undefined),
  subscribeNodeProcessKillResult: vi.fn(() => () => undefined),
}));

function rect(left: number, right: number, width = right - left): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right,
    top: 0,
    bottom: 200,
    width,
    height: 200,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('NodeProcessSelect render positioning', () => {
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 410,
    });
  });

  afterEach(() => {
    getBoundingClientRectSpy?.mockRestore();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
  });

  it('does not enter a layout update loop when the flipped dropdown has different measured bounds', async () => {
    getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getMockRect(this: HTMLElement) {
        if (this.classList.contains('node-process-dropdown')) {
          return this.style.right === '100%'
            ? rect(10, 360, 350)
            : rect(390, 740, 350);
        }
        if (this.dataset.testid === 'node-process-anchor') {
          return rect(190, 390, 200);
        }
        return rect(0, 0, 0);
      });

    const { container } = render(
      <div data-testid="node-process-anchor">
        <NodeProcessSelect embedded />
      </div>,
    );

    const dropdown = container.querySelector<HTMLElement>('.node-process-dropdown');
    expect(dropdown).not.toBeNull();

    await waitFor(() => {
      expect(dropdown?.style.right).toBe('100%');
    });
  });
});

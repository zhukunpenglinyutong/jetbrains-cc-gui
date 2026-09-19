import { act, renderHook } from '@testing-library/react';
import { useCompletionDropdown } from './useCompletionDropdown.js';
import type { CommandItem, DropdownItemData, TriggerQuery } from '../types.js';

const position = { top: 0, left: 0, width: 0, height: 0 };
const triggerQuery: TriggerQuery = { trigger: '/', query: 'review', start: 0, end: 7 };

function commandToDropdownItem(command: CommandItem): DropdownItemData {
  return {
    id: command.id,
    label: command.label,
    type: 'command',
  };
}

describe('useCompletionDropdown', () => {
  it('cancels an in-flight search when its provider changes', async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst: (items: CommandItem[]) => void = () => {};
      let firstSignal: AbortSignal | undefined;
      const firstProvider = vi.fn((_query: string, signal: AbortSignal) => {
        firstSignal = signal;
        return new Promise<CommandItem[]>(resolve => {
          resolveFirst = resolve;
        });
      });
      const secondProvider = vi.fn(
        (_query: string, _signal: AbortSignal): Promise<CommandItem[]> => Promise.resolve([])
      );

      const { result, rerender } = renderHook(
        ({ provider }) => useCompletionDropdown<CommandItem>({
          trigger: '/',
          provider,
          toDropdownItem: commandToDropdownItem,
          onSelect: vi.fn(),
        }),
        { initialProps: { provider: firstProvider } }
      );

      act(() => {
        result.current.open(position, triggerQuery);
        result.current.updateQuery(triggerQuery);
        vi.advanceTimersByTime(200);
      });

      expect(firstProvider).toHaveBeenCalledOnce();
      expect(firstSignal?.aborted).toBe(false);

      rerender({ provider: secondProvider });
      expect(firstSignal?.aborted).toBe(true);

      await act(async () => {
        resolveFirst([{ id: 'old', label: '/old' }]);
        await Promise.resolve();
      });

      expect(result.current.isOpen).toBe(false);
      expect(result.current.items).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

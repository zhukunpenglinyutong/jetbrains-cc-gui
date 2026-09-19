import {
  dollarCommandProvider,
  resetDollarCommandsState,
} from './dollarCommandProvider.js';

describe('dollarCommandProvider', () => {
  beforeEach(() => {
    resetDollarCommandsState();
    delete window.updateDollarCommands;
    delete window.__pendingDollarCommands;
  });

  it('waits for the backend payload instead of returning a loading row', async () => {
    const resultPromise = dollarCommandProvider('', new AbortController().signal);

    window.updateDollarCommands?.(JSON.stringify([
      { name: '$review-code', description: 'Review', source: 'codex-skill' },
    ]));

    await expect(resultPromise).resolves.toEqual([
      expect.objectContaining({
        id: 'review-code',
        label: '$review-code',
        contentType: 'skill',
      }),
    ]);
  });

  it('marks Codex commands that arrived on the dollar channel as commands', async () => {
    const resultPromise = dollarCommandProvider('', new AbortController().signal);

    window.updateDollarCommands?.(JSON.stringify([
      { name: 'review', type: 'command', source: 'codex-command' },
    ]));

    await expect(resultPromise).resolves.toEqual([
      expect.objectContaining({
        id: 'review',
        label: '$review',
        contentType: 'command',
      }),
    ]);
  });

  it('ignores malformed optional metadata without failing the whole payload', async () => {
    const resultPromise = dollarCommandProvider('', new AbortController().signal);

    window.updateDollarCommands?.(JSON.stringify([
      { name: '$review-code', type: { unexpected: true }, source: 42 },
    ]));

    await expect(resultPromise).resolves.toEqual([
      expect.objectContaining({
        id: 'review-code',
        contentType: 'skill',
      }),
    ]);
  });

  it('fails fast after a loading timeout instead of re-waiting on every query', async () => {
    vi.useFakeTimers();
    try {
      const firstPromise = dollarCommandProvider('', new AbortController().signal);
      await vi.advanceTimersByTimeAsync(30000);

      await expect(firstPromise).resolves.toEqual([
        expect.objectContaining({ id: '__error__' }),
      ]);

      // Later queries must resolve immediately, not wait another 30 seconds.
      await expect(
        dollarCommandProvider('', new AbortController().signal)
      ).resolves.toEqual([
        expect.objectContaining({ id: '__error__' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers when a late payload arrives after a timeout', async () => {
    vi.useFakeTimers();
    try {
      const firstPromise = dollarCommandProvider('', new AbortController().signal);
      await vi.advanceTimersByTimeAsync(30000);
      await expect(firstPromise).resolves.toEqual([
        expect.objectContaining({ id: '__error__' }),
      ]);

      window.updateDollarCommands?.(JSON.stringify([
        { name: '$review-code', source: 'codex-skill' },
      ]));

      await expect(
        dollarCommandProvider('', new AbortController().signal)
      ).resolves.toEqual([
        expect.objectContaining({ id: 'review-code', contentType: 'skill' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

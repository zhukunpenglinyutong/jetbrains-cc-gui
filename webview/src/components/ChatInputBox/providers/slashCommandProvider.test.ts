import {
  resetSlashCommandsState,
  slashCommandProvider,
} from './slashCommandProvider.js';

describe('slashCommandProvider', () => {
  beforeEach(() => {
    resetSlashCommandsState();
    delete window.updateSlashCommands;
    delete window.__pendingSlashCommands;
  });

  it('ignores malformed optional metadata without failing the whole payload', async () => {
    const resultPromise = slashCommandProvider('', new AbortController().signal);

    window.updateSlashCommands?.(JSON.stringify([
      { name: '/review', type: { unexpected: true }, source: 42, description: { unexpected: true } },
    ]));

    await expect(resultPromise).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'review',
        label: '/review',
        description: '',
        contentType: 'command',
      }),
    ]));
  });

  it('keeps valid entries when an earlier entry is malformed', async () => {
    const resultPromise = slashCommandProvider('', new AbortController().signal);

    window.updateSlashCommands?.(JSON.stringify([
      { invalid: true },
      { name: '/review', description: 'Review' },
    ]));

    await expect(resultPromise).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'review', label: '/review' }),
    ]));
  });
});

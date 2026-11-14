import {
  ompCommandProvider,
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

  it('hides commands the plugin cannot run for Claude but lists all of OMP\'s catalog', async () => {
    const pending = slashCommandProvider('', new AbortController().signal);
    window.updateSlashCommands?.(JSON.stringify([
      { name: '/todo', description: 'Manage todos', source: 'builtin' },
      { name: '/compact', description: 'Compact the conversation', source: 'builtin' },
      { name: '/new', description: 'Start a new session', source: 'builtin' },
    ]));

    expect((await pending).map(item => item.label)).toEqual(['/clear', '/compact']);
    // The plugin's own /clear still replaces the session-reset aliases for OMP.
    const ompCommands = await ompCommandProvider('', new AbortController().signal);
    expect(ompCommands.map(item => item.label)).toEqual(['/clear', '/todo', '/compact']);
  });
});

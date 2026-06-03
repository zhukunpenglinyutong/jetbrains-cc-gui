import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  sendBridgeEvent: vi.fn(() => true),
}));

vi.mock('../../utils/bridge', () => bridgeMocks);

import {
  mergeOpenCodeSlashCommandGroups,
  parseOpenCodeCommandPayload,
  preloadOpenCodeSlashCommands,
  resetOpenCodeSlashCommandsState,
} from './providers/openCodeSlashCommandProvider';
import type { CommandItem } from './types';

describe('openCodeSlashCommands', () => {
  beforeEach(() => {
    bridgeMocks.sendBridgeEvent.mockClear();
    resetOpenCodeSlashCommandsState();
  });

  it('parses discovered OpenCode commands and hides skills', () => {
    const commands = parseOpenCodeCommandPayload(JSON.stringify({
      success: true,
      commands: [
        {
          name: 'review',
          description: 'review changes',
          source: 'command',
        },
        {
          name: 'puppeteer/screenshot',
          description: 'capture page',
          source: 'mcp',
        },
        {
          name: 'ignored-skill',
          source: 'skill',
        },
      ],
    }));

    expect(commands.map((command) => command.id)).toEqual([
      'opencode-command:puppeteer/screenshot',
      'opencode-command:review',
    ]);
    expect(commands[0]).toMatchObject({
      label: '/puppeteer/screenshot',
      description: 'capture page [mcp]',
      provider: 'opencode',
      commandName: 'puppeteer/screenshot',
    });
  });

  it('groups built-in and OpenCode slash commands separately', () => {
    const builtinCommands: CommandItem[] = [{
      id: 'clear',
      label: '/clear',
      description: 'clear conversation',
      category: 'system',
    }];
    const openCodeCommands: CommandItem[] = [{
      id: 'opencode-command:review',
      label: '/review',
      description: 'review changes',
      provider: 'opencode',
      commandName: 'review',
    }];

    const grouped = mergeOpenCodeSlashCommandGroups(builtinCommands, openCodeCommands);

    expect(grouped.map((command) => command.id)).toEqual([
      '__opencode_builtin_commands__',
      'clear',
      '__opencode_native_commands__',
      'opencode-command:review',
    ]);
    expect(grouped[0].kind).toBe('section-header');
    expect(grouped[2].label).toBe('OpenCode commands');
  });

  it('preloads native commands before the slash menu opens', () => {
    preloadOpenCodeSlashCommands();
    preloadOpenCodeSlashCommands();

    expect(bridgeMocks.sendBridgeEvent).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.sendBridgeEvent).toHaveBeenCalledWith('get_opencode_commands');
  });
});

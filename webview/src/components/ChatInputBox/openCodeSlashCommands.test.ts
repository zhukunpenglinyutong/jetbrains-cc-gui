import { describe, expect, it } from 'vitest';
import {
  mergeOpenCodeSlashCommandGroups,
  parseOpenCodeCommandPayload,
} from './providers/openCodeSlashCommandProvider';
import type { CommandItem } from './types';

describe('openCodeSlashCommands', () => {
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
});

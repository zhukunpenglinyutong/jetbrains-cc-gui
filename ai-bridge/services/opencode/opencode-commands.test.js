import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOpenCodeCommands,
  parseOpenCodeSlashCommand
} from './message-service.js';

test('opencode command discovery normalizes command and mcp sources', () => {
  const commands = normalizeOpenCodeCommands([
    {
      name: 'review',
      description: 'review changes',
      source: 'command',
      hints: ['$ARGUMENTS']
    },
    {
      name: 'nested/child',
      description: 'nested command',
      source: 'command'
    },
    {
      name: 'puppeteer/screenshot',
      description: 'capture page',
      source: 'mcp'
    },
    {
      name: 'ignored-skill',
      source: 'skill'
    },
    {
      name: 'bad command',
      source: 'command'
    }
  ]);

  assert.deepEqual(commands.map((command) => command.id), [
    'opencode-command:nested/child',
    'opencode-command:puppeteer/screenshot',
    'opencode-command:review'
  ]);
  assert.equal(commands[1].description, 'capture page [mcp]');
  assert.deepEqual(commands[2].hints, ['$ARGUMENTS']);
});

test('opencode slash command parser preserves multiline arguments', () => {
  assert.deepEqual(parseOpenCodeSlashCommand('/review main\ninclude context'), {
    command: 'review',
    arguments: 'main\ninclude context'
  });
  assert.deepEqual(parseOpenCodeSlashCommand('/nested/child'), {
    command: 'nested/child',
    arguments: ''
  });
  assert.equal(parseOpenCodeSlashCommand('please /review'), null);
  assert.equal(parseOpenCodeSlashCommand('/bad? command'), null);
});

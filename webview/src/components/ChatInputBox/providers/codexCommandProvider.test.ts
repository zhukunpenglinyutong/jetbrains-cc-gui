import type { CommandItem } from '../types.js';
import {
  codexCommandProvider,
  codexCommandToDropdownItem,
} from './codexCommandProvider.js';

const { slashProvider, dollarProvider } = vi.hoisted(() => ({
  slashProvider: vi.fn(),
  dollarProvider: vi.fn(),
}));

vi.mock('./slashCommandProvider.js', () => ({
  slashCommandProvider: slashProvider,
}));

vi.mock('./dollarCommandProvider.js', () => ({
  dollarCommandProvider: dollarProvider,
}));

describe('codexCommandProvider', () => {
  beforeEach(() => {
    slashProvider.mockReset();
    dollarProvider.mockReset();
  });

  it('uses the same merged command and skill candidates for either trigger', async () => {
    const command: CommandItem = {
      id: 'review',
      label: '/review',
      contentType: 'command',
    };
    const skill: CommandItem = {
      id: 'review-code',
      label: '$review-code',
      category: 'skill',
      contentType: 'skill',
    };
    slashProvider.mockResolvedValue([command]);
    dollarProvider.mockResolvedValue([skill]);
    const signal = new AbortController().signal;

    const slashCandidates = await codexCommandProvider('review', signal);
    const dollarCandidates = await codexCommandProvider('review', signal);

    expect(slashCandidates).toEqual([
      { ...command, id: 'command:review' },
      { ...skill, id: 'skill:review-code' },
    ]);
    expect(dollarCandidates).toEqual([
      { ...command, id: 'command:review' },
      { ...skill, id: 'skill:review-code' },
    ]);
    expect(slashProvider).toHaveBeenNthCalledWith(1, 'review', signal);
    expect(dollarProvider).toHaveBeenNthCalledWith(2, 'review', signal);
  });

  it('keeps loading placeholders only when both sources have no candidates', async () => {
    const loading: CommandItem = {
      id: '__loading__',
      label: 'Loading',
      contentType: 'command',
    };
    slashProvider.mockResolvedValue([loading]);
    dollarProvider.mockResolvedValue([]);

    await expect(
      codexCommandProvider('', new AbortController().signal)
    ).resolves.toEqual([loading]);
  });

  it('renders skills with a skill icon and commands with a command icon', () => {
    expect(codexCommandToDropdownItem({
      id: 'review-code',
      label: '$review-code',
      contentType: 'skill',
    }).icon).toBe('codicon-symbol-event');
    expect(codexCommandToDropdownItem({
      id: 'review',
      label: '/review',
      contentType: 'command',
    }).icon).toBe('codicon-terminal');
  });

  it('does not label loading placeholders as commands', () => {
    expect(codexCommandToDropdownItem({
      id: '__loading__',
      label: 'Loading',
    }).contentType).toBeUndefined();
  });

  it('keeps commands and skills selectable when they share a base name', async () => {
    const command: CommandItem = {
      id: 'review',
      label: '/review',
      contentType: 'command',
    };
    const skill: CommandItem = {
      id: 'review',
      label: '$review',
      contentType: 'skill',
    };
    slashProvider.mockResolvedValue([command]);
    dollarProvider.mockResolvedValue([skill]);

    const items = await codexCommandProvider('', new AbortController().signal);

    expect(items.map(item => item.id)).toEqual(['command:review', 'skill:review']);
    expect(codexCommandToDropdownItem(items[0]).label).toBe('/review');
    expect(codexCommandToDropdownItem(items[1]).label).toBe('$review');
  });

  it('rewrites a skill that arrived with a slash label so the picker matches insertion', () => {
    expect(codexCommandToDropdownItem({
      id: 'review-code',
      label: '/review-code',
      contentType: 'skill',
    }).label).toBe('$review-code');
  });
});

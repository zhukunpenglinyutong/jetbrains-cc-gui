import {
  getCommandContentType,
  getCommandDisplayLabel,
  getCommandInsertionText,
  isCommandPlaceholder,
} from './commandCompletionUtils.js';
import type { CommandItem } from '../types.js';

describe('command completion content handling', () => {
  it('fills a skill with the dollar invocation prefix regardless of trigger', () => {
    const skill: CommandItem = {
      id: 'review-code',
      label: '$review-code',
      category: 'skill',
      contentType: 'skill',
    };

    expect(getCommandInsertionText(skill)).toBe('$review-code ');
  });

  it('fills a command with the slash invocation prefix regardless of trigger', () => {
    const command: CommandItem = {
      id: 'review',
      label: '/review',
      contentType: 'command',
    };

    expect(getCommandInsertionText(command)).toBe('/review ');
  });

  it('uses explicit content type before legacy category or label fallbacks', () => {
    const command: CommandItem = {
      id: 'review',
      label: '$review',
      category: 'skill',
      contentType: 'command',
    };

    expect(getCommandContentType(command)).toBe('command');
    expect(getCommandInsertionText(command)).toBe('/review ');
  });

  it('rewrites a mismatched source prefix in the displayed label', () => {
    expect(getCommandDisplayLabel({
      id: 'review-code',
      label: '/review-code',
      contentType: 'skill',
    })).toBe('$review-code');
  });

  it('leaves loading and error placeholder labels unprefixed', () => {
    const loading: CommandItem = {
      id: '__loading__',
      label: 'Loading',
      category: 'system',
    };

    expect(isCommandPlaceholder(loading)).toBe(true);
    expect(getCommandInsertionText(loading)).toBe('Loading ');
  });

  it('does not mistake a valid double-underscore command for a placeholder', () => {
    const command: CommandItem = {
      id: '__internal-review',
      label: '/__internal-review',
      contentType: 'command',
    };

    expect(isCommandPlaceholder(command)).toBe(false);
    expect(getCommandInsertionText(command)).toBe('/__internal-review ');
  });
});

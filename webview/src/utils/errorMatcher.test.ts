import { describe, expect, it } from 'vitest';
import { matchErrorPattern } from './errorMatcher';

describe('matchErrorPattern', () => {
  it('returns null for empty input', () => {
    expect(matchErrorPattern('')).toBeNull();
  });

  it('matches when regex and all keywords are present', () => {
    const text =
      'Error: Native CLI binary for claude-agent-sdk not found in node_modules';
    const result = matchErrorPattern(text);
    expect(result).not.toBeNull();
    expect(result?.code).toBe('sdkNativeBinaryMissing');
    expect(result?.solutions).toHaveLength(2);
  });

  it('matches case-insensitively on the regex portion', () => {
    const text = 'NATIVE CLI BINARY FOR claude-agent-sdk NOT FOUND';
    const result = matchErrorPattern(text);
    expect(result?.code).toBe('sdkNativeBinaryMissing');
  });

  it('returns null when the regex matches but keywords are missing', () => {
    // Regex matches, but the required "claude-agent-sdk" keyword is absent
    const text = 'Native CLI binary for some-other-sdk not found';
    expect(matchErrorPattern(text)).toBeNull();
  });

  it('returns null when no pattern matches the error text', () => {
    expect(matchErrorPattern('Some unrelated error message')).toBeNull();
  });

  it('returns the first pattern whose regex and keywords both match', () => {
    const text =
      'Internal error: Native CLI binary for claude-agent-sdk not found while loading';
    const result = matchErrorPattern(text);
    expect(result?.code).toBe('sdkNativeBinaryMissing');
  });

  it('exposes solutions with the expected step kinds', () => {
    const text =
      'Native CLI binary for claude-agent-sdk not found in installation directory';
    const result = matchErrorPattern(text);
    const switchRegistry = result?.solutions.find((s) => s.key === 'switchRegistry');
    expect(switchRegistry?.recommended).toBe(true);
    expect(switchRegistry?.steps[0]?.kind).toBe('command');
    expect(switchRegistry?.steps[1]?.kind).toBe('navigation');
  });
});

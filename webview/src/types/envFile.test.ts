import { describe, expect, it } from 'vitest';
import {
  normalizeEnvFilePath,
  parseEnvFileState,
  parseEnvFileUpdate,
} from './envFile';

describe('parseEnvFileState', () => {
  it('passes through the three backend states', () => {
    expect(parseEnvFileState('configured', false)).toBe('configured');
    expect(parseEnvFileState('notConfigured', false)).toBe('notConfigured');
    expect(parseEnvFileState('disabled', true)).toBe('disabled');
  });

  it('falls back to unknown instead of a reassuring default', () => {
    expect(parseEnvFileState(undefined, undefined)).toBe('unknown');
    expect(parseEnvFileState(null, false)).toBe('unknown');
    expect(parseEnvFileState('', false)).toBe('unknown');
    expect(parseEnvFileState('CONFIGURED', false)).toBe('unknown');
    expect(parseEnvFileState(42, false)).toBe('unknown');
    expect(parseEnvFileState({ state: 'configured' }, false)).toBe('unknown');
  });

  it('downgrades contradictory payloads to unknown', () => {
    expect(parseEnvFileState('configured', true)).toBe('unknown');
    expect(parseEnvFileState('notConfigured', true)).toBe('unknown');
    expect(parseEnvFileState('disabled', false)).toBe('unknown');
  });
});

describe('parseEnvFileUpdate', () => {
  it('reads the configured state and the path', () => {
    expect(
      parseEnvFileUpdate(
        JSON.stringify({
          envFile: '/projects/app/.env.local',
          envFileState: 'configured',
          envFileDisabled: false,
        }),
      ),
    ).toEqual({ envFile: '/projects/app/.env.local', state: 'configured' });
  });

  it('keeps the empty path of the opt-out state', () => {
    expect(
      parseEnvFileUpdate(
        JSON.stringify({ envFile: '', envFileState: 'disabled', envFileDisabled: true }),
      ),
    ).toEqual({ envFile: '', state: 'disabled' });
  });

  it('degrades to unknown on malformed payloads instead of throwing', () => {
    expect(parseEnvFileUpdate('not json')).toEqual({ envFile: '', state: 'unknown' });
    expect(parseEnvFileUpdate('"a string"')).toEqual({ envFile: '', state: 'unknown' });
    expect(parseEnvFileUpdate('[]')).toEqual({ envFile: '', state: 'unknown' });
    expect(parseEnvFileUpdate('{"envFile": 12}')).toEqual({ envFile: '', state: 'unknown' });
    expect(parseEnvFileUpdate('{"envFileState": "configured"}')).toEqual({
      envFile: '',
      state: 'configured',
    });
  });
});

describe('normalizeEnvFilePath', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeEnvFilePath('  /projects/app/.env \n')).toEqual({
      ok: true,
      value: '/projects/app/.env',
    });
  });

  it('treats an empty value as the explicit opt-out, not an error', () => {
    expect(normalizeEnvFilePath('')).toEqual({ ok: true, value: '' });
    expect(normalizeEnvFilePath('   ')).toEqual({ ok: true, value: '' });
  });

  it('rejects parent traversal in both separator styles', () => {
    expect(normalizeEnvFilePath('../secrets.env')).toEqual({
      ok: false,
      issue: 'parentTraversal',
    });
    expect(normalizeEnvFilePath('/projects/../etc/passwd')).toEqual({
      ok: false,
      issue: 'parentTraversal',
    });
    expect(normalizeEnvFilePath('..\\..\\secrets.env')).toEqual({
      ok: false,
      issue: 'parentTraversal',
    });
  });

  it('rejects NUL bytes and other control characters', () => {
    expect(normalizeEnvFilePath('/projects/app/.env\u0000.txt')).toEqual({
      ok: false,
      issue: 'invalidCharacters',
    });
    expect(normalizeEnvFilePath('/projects/app/.env\nrm -rf /')).toEqual({
      ok: false,
      issue: 'invalidCharacters',
    });
  });

  it('rejects absurdly long paths', () => {
    expect(normalizeEnvFilePath(`/${'a'.repeat(5000)}`)).toEqual({
      ok: false,
      issue: 'tooLong',
    });
  });

  it('keeps dots that are not traversal segments', () => {
    expect(normalizeEnvFilePath('./.env')).toEqual({ ok: true, value: './.env' });
    expect(normalizeEnvFilePath('/projects/app..name/.env')).toEqual({
      ok: true,
      value: '/projects/app..name/.env',
    });
  });
});

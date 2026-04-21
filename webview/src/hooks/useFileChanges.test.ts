import { describe, expect, it } from 'vitest';
import { isLikelyFileChangePath } from './useFileChanges';

describe('isLikelyFileChangePath', () => {
  it('accepts normal relative, absolute, and special file names', () => {
    expect(isLikelyFileChangePath('webview/src/App.tsx')).toBe(true);
    expect(isLikelyFileChangePath('D:\\dev\\custom - xt\\TG Tool\\electron\\renderer\\src\\App.tsx')).toBe(true);
    expect(isLikelyFileChangePath('.gitignore')).toBe(true);
    expect(isLikelyFileChangePath('Dockerfile')).toBe(true);
  });

  it('rejects code fragments that should not appear in the edits panel', () => {
    expect(isLikelyFileChangePath('JSON.parse(task.account_ids_json)')).toBe(false);
    expect(isLikelyFileChangePath('((await response.json()) as ApiEnvelope<T> | { detail?: string })')).toBe(false);
    expect(isLikelyFileChangePath('${Math.max(historyMeta.total_pages, 1)} 页`')).toBe(false);
    expect(isLikelyFileChangePath('n${content.trim()}`')).toBe(false);
  });
});

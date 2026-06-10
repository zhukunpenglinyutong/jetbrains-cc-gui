import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App shell toast mounting', () => {
  it('does not mount the global chat toast container', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

    expect(source).not.toContain('<ToastContainer');
  });
});

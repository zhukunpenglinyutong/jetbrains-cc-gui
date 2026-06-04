import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styleRoot = resolve(__dirname);

function readStyle(relativePath: string): string {
  return readFileSync(resolve(styleRoot, relativePath), 'utf8');
}

describe('responsive chat layout styles', () => {
  it('defines the app shell as the container query boundary', () => {
    const baseStyles = readStyle('less/base.less');

    expect(baseStyles).toContain('container-type: inline-size');
    expect(baseStyles).toContain('container-name: app-shell');
  });

  it('keeps responsive rules for chat, status panel, and input controls', () => {
    const responsiveStyles = readStyle('less/responsive.less');

    expect(responsiveStyles).toContain('@container app-shell (max-width: 520px)');
    expect(responsiveStyles).toContain('@container app-shell (min-width: 521px) and (max-width: 820px)');
    expect(responsiveStyles).toContain('@container app-shell (min-width: 980px)');
    expect(responsiveStyles).toContain('.message');
    expect(responsiveStyles).toContain('.status-panel-tab .tab-label');
    expect(responsiveStyles).toContain('.button-area');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openBrowser,
  openClass,
  openFile,
  showEditableDiff,
  showInteractiveDiff,
  undoFileChanges,
} from './bridge';

describe('bridge navigation helpers', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('allows relative navigation paths for openFile', () => {
    openFile('../shared/utils.ts');
    expect(window.sendToJava).toHaveBeenCalledWith('open_file:../shared/utils.ts');
  });

  it('sends openClass for valid Java FQCN values', () => {
    openClass('com.github.claudecodegui.handler.file.OpenFileHandler');
    expect(window.sendToJava).toHaveBeenCalledWith(
      'open_class:com.github.claudecodegui.handler.file.OpenFileHandler',
    );
  });

  it('shares the same trimmed FQCN validation rules as linkify', () => {
    openClass(' com.github.foo.BarService ');
    openClass('com.github.foo.Outer.Inner');
    openClass('org.junit.jupiter.api');
    openClass('com.github.foo.Bar.baz()');

    expect(window.sendToJava).toHaveBeenNthCalledWith(1, 'open_class:com.github.foo.BarService');
    expect(window.sendToJava).toHaveBeenNthCalledWith(2, 'open_class:com.github.foo.Outer.Inner');
    expect(window.sendToJava).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid Java class expressions', () => {
    openClass('com.github.foo.Bar#baz');
    expect(window.sendToJava).not.toHaveBeenCalled();
  });

  it('keeps traversal guards for mutating file APIs', () => {
    showEditableDiff('../shared/utils.ts', [], 'M');
    showInteractiveDiff('../shared/utils.ts', 'next');
    undoFileChanges('../shared/utils.ts', 'M', []);

    expect(window.sendToJava).not.toHaveBeenCalled();
  });

  it('allows http, https, and mailto protocols for openBrowser', () => {
    openBrowser('https://example.com/docs');
    openBrowser('http://example.com');
    openBrowser('mailto:test@example.com');

    expect(window.sendToJava).toHaveBeenNthCalledWith(1, 'open_browser:https://example.com/docs');
    expect(window.sendToJava).toHaveBeenNthCalledWith(2, 'open_browser:http://example.com');
    expect(window.sendToJava).toHaveBeenNthCalledWith(3, 'open_browser:mailto:test@example.com');
  });

  it('rejects file: and javascript: protocols in openBrowser', () => {
    openBrowser('file:///etc/passwd');
    openBrowser('javascript:alert(1)');

    expect(window.sendToJava).not.toHaveBeenCalled();
  });
});

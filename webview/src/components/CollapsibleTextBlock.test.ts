import { describe, expect, it } from 'vitest';
import { convertAtFileRefsToLinks } from './CollapsibleTextBlock';

describe('convertAtFileRefsToLinks', () => {
  // ── 基本路径匹配 ──────────────────────────────────

  it('converts Windows absolute paths', () => {
    const result = convertAtFileRefsToLinks('见 @C:\\src\\app.ts');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="C:\\src\\app.ts" title="C:\\src\\app.ts">@app.ts</a>'
    );
  });

  it('converts POSIX absolute paths', () => {
    const result = convertAtFileRefsToLinks('见 @/home/user/app.ts');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="/home/user/app.ts" title="/home/user/app.ts">@app.ts</a>'
    );
  });

  it('converts explicit relative paths', () => {
    const result = convertAtFileRefsToLinks('@./src/utils.ts');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="./src/utils.ts" title="./src/utils.ts">@utils.ts</a>'
    );
  });

  it('converts parent-relative paths', () => {
    const result = convertAtFileRefsToLinks('@../common/base.ts');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="../common/base.ts" title="../common/base.ts">@base.ts</a>'
    );
  });

  it('converts project-relative paths', () => {
    const result = convertAtFileRefsToLinks('@src/utils/bridge.ts');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="src/utils/bridge.ts" title="src/utils/bridge.ts">@bridge.ts</a>'
    );
  });

  it('converts bare filenames with extension', () => {
    const result = convertAtFileRefsToLinks('@package.json');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="package.json" title="package.json">@package.json</a>'
    );
  });

  // ── 行号 ──────────────────────────────────────────

  it('converts path with single line number', () => {
    const result = convertAtFileRefsToLinks('@src/app.ts#L42');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="src/app.ts:42" title="src/app.ts">@app.ts#L42</a>'
    );
  });

  it('converts path with line range', () => {
    const result = convertAtFileRefsToLinks('@src/app.ts#L10-20');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="src/app.ts:10-20" title="src/app.ts">@app.ts#L10-20</a>'
    );
  });

  // ── 路径含空格 ────────────────────────────────────

  it('preserves spaces inside file paths', () => {
    const result = convertAtFileRefsToLinks('@C:\\Users\\John Doe\\file.ts');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="C:\\Users\\John%20Doe\\file.ts" title="C:\\Users\\John Doe\\file.ts">@file.ts</a>'
    );
  });

  it('preserves spaces with line numbers', () => {
    const result = convertAtFileRefsToLinks('@C:\\Users\\John Doe\\file.ts#L10-20');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="C:\\Users\\John%20Doe\\file.ts:10-20" title="C:\\Users\\John Doe\\file.ts">@file.ts#L10-20</a>'
    );
  });

  it('stops collecting at space that is not a path continuation', () => {
    const result = convertAtFileRefsToLinks('请在 @file.ts 中查看');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="file.ts" title="file.ts">@file.ts</a>'
    );
    // "中查看" 不是路径的一部分
    expect(result).toContain('中查看');
  });

  it('preserves spaces inside CJK filenames', () => {
    const result = convertAtFileRefsToLinks(
      '@D:\\workspace\\hello-agents\\docs\\chapter6\\第六章 框架开发实践.md'
    );
    // 空格后的 "框架开发实践.md" 以 .md 结尾，属于路径片段，不应截断
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="D:\\workspace\\hello-agents\\docs\\chapter6\\第六章%20框架开发实践.md" title="D:\\workspace\\hello-agents\\docs\\chapter6\\第六章 框架开发实践.md">@第六章 框架开发实践.md</a>'
    );
  });

  it('preserves spaces inside CJK filenames with line number', () => {
    const result = convertAtFileRefsToLinks(
      '@D:\\workspace\\hello-agents\\docs\\chapter6\\第六章 框架开发实践.md#L10-20'
    );
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="D:\\workspace\\hello-agents\\docs\\chapter6\\第六章%20框架开发实践.md:10-20" title="D:\\workspace\\hello-agents\\docs\\chapter6\\第六章 框架开发实践.md">@第六章 框架开发实践.md#L10-20</a>'
    );
  });

  // ── 路径含 # 但不匹配行号 ─────────────────────────

  it('does not split on # inside path when not #L format (C# files)', () => {
    const result = convertAtFileRefsToLinks('@C:\\src\\C#\\App.cs#L10');
    // rawPath 应为 C:\src\C#\App.cs (lastIndexOf 取最后一个 #，匹配 #L10 格式)
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="C:\\src\\C#\\App.cs:10" title="C:\\src\\C#\\App.cs">@App.cs#L10</a>'
    );
  });

  it('does not treat non-line # suffix as line marker', () => {
    // file#123 无扩展名，不被识别为文件引用
    const result = convertAtFileRefsToLinks('@file#123');
    expect(result).toBe('@file#123');
  });

  it('does not treat path with non-line # suffix as file ref', () => {
    // #123 不匹配 #L\d+ 格式，保留在路径末尾，isLikelyFilePath 因后缀而不识别扩展名
    const result = convertAtFileRefsToLinks('@App.cs#123');
    expect(result).toBe('@App.cs#123');
  });

  // ── 非路径 @mention 不匹配 ────────────────────────

  it('does not convert bare @mentions (no path-like structure)', () => {
    const result = convertAtFileRefsToLinks('你好 @someone 快来');
    expect(result).toBe('你好 @someone 快来');
  });

  it('does not convert CJK @mentions', () => {
    const result = convertAtFileRefsToLinks('@你好');
    expect(result).toBe('@你好');
  });

  // ── @@ 转义 ───────────────────────────────────────

  it('preserves @@ as literal text', () => {
    const result = convertAtFileRefsToLinks('见 @@src/app.ts');
    // @@ 应跳过，不渲染为链接
    expect(result).not.toContain('data-linkify');
    expect(result).toContain('@@src/app.ts');
  });

  it('mixes @@ escape with real @refs', () => {
    const result = convertAtFileRefsToLinks('见@@src/app.ts和@src/utils.ts');
    // @@ 之后的 src/app.ts 不是 @ 开头，不渲染
    // @src/utils.ts 渲染为链接
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="src/utils.ts" title="src/utils.ts">@utils.ts</a>'
    );
    expect(result).toContain('@@src/app.ts');
  });

  // ── 混合文本 ──────────────────────────────────────

  it('handles text before and after @ref', () => {
    const result = convertAtFileRefsToLinks('打开 @src/app.ts 查看');
    expect(result).toContain('打开 ');
    expect(result).toContain(' 查看');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="src/app.ts" title="src/app.ts">@app.ts</a>'
    );
  });

  it('handles multiple @refs in one line', () => {
    const result = convertAtFileRefsToLinks('@a.ts 和 @b.ts');
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="a.ts" title="a.ts">@a.ts</a>'
    );
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="b.ts" title="b.ts">@b.ts</a>'
    );
  });

  it('handles adjacent @refs', () => {
    const result = convertAtFileRefsToLinks('@a.ts@b.ts');
    // 第一个 @ 消耗 a.ts，第二个 @ 消耗 b.ts
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="a.ts" title="a.ts">@a.ts</a>'
    );
    expect(result).toContain(
      '<a class="file-link" data-linkify="file" href="b.ts" title="b.ts">@b.ts</a>'
    );
  });

  // ── 边界条件 ──────────────────────────────────────

  it('returns empty string for empty input', () => {
    expect(convertAtFileRefsToLinks('')).toBe('');
  });

  it('returns escaped text for input without @', () => {
    const result = convertAtFileRefsToLinks('hello <world>');
    expect(result).toContain('hello &lt;world&gt;');
  });

  it('escapes HTML in text around @refs', () => {
    const result = convertAtFileRefsToLinks('<b>打开</b> @src/app.ts');
    expect(result).toContain('&lt;b&gt;打开&lt;/b&gt; ');
  });

  it('handles @ at end of string (no path follows)', () => {
    const result = convertAtFileRefsToLinks('你好@');
    // 独立的 @ 不参与任何匹配
    expect(result).toBe('你好@');
  });
});

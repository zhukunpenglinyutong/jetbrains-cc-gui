import { renderHook } from '@testing-library/react';
import { useFileTags } from './useFileTags.js';

function createEditable() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el as HTMLDivElement;
}

function mockSelection() {
  const selection = {
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
    rangeCount: 0,
  };
  vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
  return selection;
}

function setupHook(editable: HTMLDivElement) {
  return renderHook(() =>
    useFileTags({
      editableRef: { current: editable },
      getTextContent: () => editable.textContent ?? '',
      onCloseCompletions: vi.fn(),
    })
  );
}

describe('useFileTags', () => {
  it('renders file tags for valid references', () => {
    const editable = createEditable();
    editable.textContent = '@src/a.ts ';
    mockSelection();

    const { result } = setupHook(editable);

    result.current.pathMappingRef.current.set('src/a.ts', 'C:\\src\\a.ts');
    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(1);
    expect(result.current.extractFileTags()).toEqual([
      { displayPath: 'src/a.ts', absolutePath: 'C:\\src\\a.ts' },
    ]);

    const close = editable.querySelector('.file-tag-close') as HTMLElement;
    close.click();
    expect(editable.querySelectorAll('.file-tag').length).toBe(0);
  });

  it('does not render tags for unknown references', () => {
    const editable = createEditable();
    editable.textContent = '@unknown/file.ts ';

    const { result } = setupHook(editable);

    result.current.renderFileTags();
    expect(editable.querySelectorAll('.file-tag').length).toBe(0);
  });

  it('does not promote an unregistered absolute path with following text into a tag', () => {
    const editable = createEditable();
    const rawText = '@C:/project/templates/view.xml1414 @C:/project/pages/index.vue';
    editable.textContent = rawText;

    const { result } = setupHook(editable);

    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(0);
    expect(editable.textContent).toBe(rawText);
  });

  it('keeps the manual absolute-path fallback when other @ markers are ordinary text', () => {
    const editable = createEditable();
    editable.textContent = 'email user@example.com about @/workspace/src/App.ts ';
    mockSelection();

    const { result } = setupHook(editable);

    result.current.renderFileTags();

    const tags = editable.querySelectorAll('.file-tag');
    expect(tags.length).toBe(1);
    expect(tags[0].getAttribute('data-file-path')).toBe('/workspace/src/App.ts');
  });

  it('does not close completions or rewrite DOM for in-progress @query', () => {
    const editable = createEditable();
    editable.textContent = '@b';
    const textNode = editable.firstChild;
    const onCloseCompletions = vi.fn();

    const { result } = renderHook(() =>
      useFileTags({
        editableRef: { current: editable },
        getTextContent: () => editable.textContent ?? '',
        onCloseCompletions,
      })
    );

    result.current.renderFileTags();

    // Regression: an in-progress completion query ("@b") must not close the
    // open dropdown nor touch the DOM (the "flash then disappear" bug).
    expect(onCloseCompletions).not.toHaveBeenCalled();
    expect(editable.firstChild).toBe(textNode);
    expect(editable.querySelectorAll('.file-tag').length).toBe(0);
  });

  it('preserves an existing file tag when only unrelated raw @ text remains', () => {
    const editable = createEditable();
    const existingTag = document.createElement('span');
    existingTag.className = 'file-tag';
    existingTag.setAttribute('data-file-path', 'README.md');
    existingTag.textContent = 'README.md';
    editable.append(existingTag, document.createTextNode(' @GetMapping("/test")'));
    const onCloseCompletions = vi.fn();

    const { result } = renderHook(() =>
      useFileTags({
        editableRef: { current: editable },
        // Mirrors useTextContent: existing chips are serialized into @path.
        getTextContent: () => '@README.md @GetMapping("/test")',
        onCloseCompletions,
      })
    );
    result.current.pathMappingRef.current.set('README.md', '/project/README.md');

    result.current.renderFileTags();

    expect(editable.querySelector('.file-tag')).toBe(existingTag);
    expect(onCloseCompletions).not.toHaveBeenCalled();
  });

  it('renders a new valid raw reference alongside an existing file tag', () => {
    const editable = createEditable();
    const existingTag = document.createElement('span');
    existingTag.className = 'file-tag';
    existingTag.setAttribute('data-file-path', 'README.md');
    existingTag.textContent = 'README.md';
    editable.append(existingTag, document.createTextNode(' @src/a.ts '));
    mockSelection();

    const { result } = renderHook(() =>
      useFileTags({
        editableRef: { current: editable },
        getTextContent: () => '@README.md @src/a.ts ',
        onCloseCompletions: vi.fn(),
      })
    );
    result.current.pathMappingRef.current.set('README.md', '/project/README.md');
    result.current.pathMappingRef.current.set('src/a.ts', '/project/src/a.ts');

    result.current.renderFileTags();

    const paths = Array.from(editable.querySelectorAll('.file-tag'))
      .map((tag) => tag.getAttribute('data-file-path'));
    expect(paths).toEqual(['README.md', 'src/a.ts']);
  });

  it('recognizes a valid raw reference split across adjacent inline elements', () => {
    const editable = createEditable();
    const firstPart = document.createElement('span');
    firstPart.textContent = '@src/';
    const secondPart = document.createElement('span');
    secondPart.textContent = 'a.ts ';
    editable.append(firstPart, secondPart);
    mockSelection();

    const { result } = renderHook(() =>
      useFileTags({
        editableRef: { current: editable },
        getTextContent: () => '@src/a.ts ',
        onCloseCompletions: vi.fn(),
      })
    );
    result.current.pathMappingRef.current.set('src/a.ts', '/project/src/a.ts');

    result.current.renderFileTags();

    expect(editable.querySelector('.file-tag')?.getAttribute('data-file-path')).toBe('src/a.ts');
  });

  it('does not let quote chip decoration authorize a file-tag rebuild', () => {
    const editable = createEditable();
    const quoteTag = document.createElement('span');
    quoteTag.className = 'quote-tag';
    quoteTag.textContent = '@README.md';
    editable.append(quoteTag, document.createTextNode(' @GetMapping("/test")'));
    const onCloseCompletions = vi.fn();

    const { result } = renderHook(() =>
      useFileTags({
        editableRef: { current: editable },
        getTextContent: () => '@README.md @GetMapping("/test")',
        onCloseCompletions,
      })
    );
    result.current.pathMappingRef.current.set('README.md', '/project/README.md');

    result.current.renderFileTags();

    expect(editable.querySelector('.quote-tag')).toBe(quoteTag);
    expect(onCloseCompletions).not.toHaveBeenCalled();
  });

  it('renders file tags for paths with spaces', () => {
    const editable = createEditable();
    editable.textContent = '@my file.ts ';
    mockSelection();

    const { result } = setupHook(editable);

    result.current.pathMappingRef.current.set('my file.ts', '/abs/my file.ts');
    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(1);
    expect(result.current.extractFileTags()).toEqual([
      { displayPath: 'my file.ts', absolutePath: '/abs/my file.ts' },
    ]);
  });

  it('selects longest matching path when multiple paths overlap', () => {
    const editable = createEditable();
    editable.textContent = '@src/my file.ts ';
    mockSelection();

    const { result } = setupHook(editable);

    result.current.pathMappingRef.current.set('src/my', '/abs/src/my');
    result.current.pathMappingRef.current.set('src/my file.ts', '/abs/src/my file.ts');
    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(1);
    expect(result.current.extractFileTags()).toEqual([
      { displayPath: 'src/my file.ts', absolutePath: '/abs/src/my file.ts' },
    ]);
  });

  it('renders multiple file tags including ones with spaces', () => {
    const editable = createEditable();
    editable.textContent = '@src/a.ts @my doc.md ';
    mockSelection();

    const { result } = setupHook(editable);

    result.current.pathMappingRef.current.set('src/a.ts', '/abs/src/a.ts');
    result.current.pathMappingRef.current.set('my doc.md', '/abs/my doc.md');
    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(2);
    expect(result.current.extractFileTags()).toEqual([
      { displayPath: 'src/a.ts', absolutePath: '/abs/src/a.ts' },
      { displayPath: 'my doc.md', absolutePath: '/abs/my doc.md' },
    ]);
  });

  it('renders only a registered line-number reference with a spaced path', () => {
    const editable = createEditable();
    editable.textContent = '@C:/Program Files/src/Main.java#L10-12 ';
    mockSelection();

    const { result } = setupHook(editable);
    result.current.pathMappingRef.current.set(
      'C:/Program Files/src/Main.java',
      'C:/Program Files/src/Main.java'
    );
    result.current.pathMappingRef.current.set(
      'C:/Program Files/src/Main.java#L10-12',
      'C:/Program Files/src/Main.java'
    );

    result.current.renderFileTags();

    expect(editable.querySelector('.file-tag')?.getAttribute('data-file-path')).toBe(
      'C:/Program Files/src/Main.java#L10-12'
    );
  });

  it('keeps mapped markup references separate from text between files', () => {
    const editable = createEditable();
    editable.textContent =
      '@C:/project/templates/view.xml 1414 @C:/project/pages/index.vue ';
    mockSelection();

    const { result } = setupHook(editable);
    result.current.pathMappingRef.current.set(
      'C:/project/templates/view.xml',
      'C:/project/templates/view.xml'
    );
    result.current.pathMappingRef.current.set(
      'C:/project/pages/index.vue',
      'C:/project/pages/index.vue'
    );

    result.current.renderFileTags();

    expect(Array.from(editable.querySelectorAll('.file-tag')).map((tag) =>
      tag.getAttribute('data-file-path')
    )).toEqual([
      'C:/project/templates/view.xml',
      'C:/project/pages/index.vue',
    ]);
    expect(editable.textContent).toContain('1414');
  });

  it('handles path at end of text without trailing space', () => {
    const editable = createEditable();
    editable.textContent = '@src/a.ts';
    mockSelection();

    const { result } = setupHook(editable);

    result.current.pathMappingRef.current.set('src/a.ts', '/abs/src/a.ts');
    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(1);
  });

  it('renders absolute paths with spaces in the filename (not in path mapping)', () => {
    const editable = createEditable();
    editable.textContent = '@D:\\workspace\\docs\\chapter6\\第六章 框架开发实践.md ';
    mockSelection();

    const { result } = setupHook(editable);

    // No pathMappingRef entry: falls back to absolute-path pattern matching.
    // The space before "框架开发实践.md" must not truncate the path.
    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(1);
    expect(result.current.extractFileTags()).toEqual([
      {
        displayPath: 'D:\\workspace\\docs\\chapter6\\第六章 框架开发实践.md',
        absolutePath: 'D:\\workspace\\docs\\chapter6\\第六章 框架开发实践.md',
      },
    ]);
  });

  it('renders absolute paths with spaces and a line marker (not in path mapping)', () => {
    const editable = createEditable();
    editable.textContent = '@D:\\docs\\第六章 框架开发实践.md#L10-20 ';
    mockSelection();

    const { result } = setupHook(editable);

    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(1);
    expect(result.current.extractFileTags()).toEqual([
      {
        displayPath: 'D:\\docs\\第六章 框架开发实践.md#L10-20',
        absolutePath: 'D:\\docs\\第六章 框架开发实践.md#L10-20',
      },
    ]);
  });
});

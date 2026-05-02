import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  decorateFileReferences,
  findFileReferenceMatches,
  getFileReferenceCacheKey,
  resetFileReferenceResolutionForTests,
} from './fileReferenceLinks';

describe('file reference link parsing', () => {
  it('detects supported English and Chinese file line formats', () => {
    const text = [
      'SubjectCategoryController.java (line 64)',
      'SubjectCategoryController.java(line 65)',
      'SubjectCategoryController.java:83',
      'SubjectCategoryController.java:84:3',
      'SubjectCategoryController.java#L85',
      'SubjectCategoryController.java#L86C4',
      'SubjectCategoryController.java (lines 87-89)',
      'SubjectCategoryController.java line 153',
      'src/main/java/com/example/User.java (line 18)',
      'D:/project/src/main/java/com/example/User.java (line 20)',
      'User.java（line 21）',
      'User.java（行 22）',
      'User.java（第 23 行）',
      'User.java（第 24-26 行）',
    ].join('\n');

    const matches = findFileReferenceMatches(text);

    expect(matches.map((match) => [match.pathText, match.line])).toEqual([
      ['SubjectCategoryController.java', 64],
      ['SubjectCategoryController.java', 65],
      ['SubjectCategoryController.java', 83],
      ['SubjectCategoryController.java', 84],
      ['SubjectCategoryController.java', 85],
      ['SubjectCategoryController.java', 86],
      ['SubjectCategoryController.java', 87],
      ['SubjectCategoryController.java', 153],
      ['src/main/java/com/example/User.java', 18],
      ['D:/project/src/main/java/com/example/User.java', 20],
      ['User.java', 21],
      ['User.java', 22],
      ['User.java', 23],
      ['User.java', 24],
    ]);
  });

  it('detects source file references even when no line number is present', () => {
    const matches = findFileReferenceMatches([
      '文件：workstudy-wechat/.../WechatLoginApplicationService.java',
      '文件：workstudy-user/.../CommunityCommentLikeRedisMqProducer.java',
      '不要匹配 example.com 或 ApplicationTools.getApplicationOverview()',
    ].join('\n'));

    expect(matches.map((match) => [match.pathText, match.line])).toEqual([
      ['workstudy-wechat/.../WechatLoginApplicationService.java', 0],
      ['workstudy-user/.../CommunityCommentLikeRedisMqProducer.java', 0],
    ]);
  });

  it('does not detect file references inside URLs', () => {
    const matches = findFileReferenceMatches(
      'Open http://example.com/src/User.java:64 and file://D:/project/User.java:65, but keep Real.java:66',
    );

    expect(matches.map((match) => match.originalText)).toEqual(['Real.java:66']);
  });

  it('normalizes cache keys by trimming and converting path separators', () => {
    expect(getFileReferenceCacheKey(' src\\main\\java\\User.java ', 64)).toBe('src/main/java/User.java:64');
  });
});

describe('file reference DOM decoration', () => {
  beforeEach(() => {
    resetFileReferenceResolutionForTests();
    vi.restoreAllMocks();
    delete window.sendToJava;
    delete window.onFileReferenceResolveResult;
    document.body.innerHTML = '';
  });

  it('marks candidates as pending and resolves them into clickable links', () => {
    window.sendToJava = vi.fn();
    const container = document.createElement('div');
    container.textContent = '接口：SubjectCategoryController.java (line 64)';
    document.body.appendChild(container);

    decorateFileReferences(container);

    const pending = container.querySelector('.file-reference-pending') as HTMLElement;
    expect(pending).toBeTruthy();
    expect(pending.dataset.originalText).toBe('SubjectCategoryController.java (line 64)');
    expect(window.sendToJava).toHaveBeenCalledTimes(1);

    const message = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(message.replace(/^resolve_file_references:/, ''));

    window.onFileReferenceResolveResult?.(JSON.stringify({
      requestId: payload.requestId,
      results: [{
        id: payload.references[0].id,
        pathText: 'SubjectCategoryController.java',
        resolvedPath: 'D:/project/src/SubjectCategoryController.java',
        line: 64,
        resolved: true,
      }],
    }));

    const link = container.querySelector('.file-reference-link') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('SubjectCategoryController.java (line 64)');
    expect(link.dataset.resolvedPath).toBe('D:/project/src/SubjectCategoryController.java');
    expect(link.dataset.line).toBe('64');
    expect(link.title).toBe('D:/project/src/SubjectCategoryController.java (line 64)');
  });

  it('sends nearby code context so ambiguous filenames can resolve to the matching file', () => {
    window.sendToJava = vi.fn();
    const container = document.createElement('div');
    container.innerHTML = [
      '<p>入口位于 registry.py:42，函数：</p>',
      '<pre><code>def _module_registers_tools(module_path: Path) -&gt; bool:\n    source = module_path.read_text(encoding=&quot;utf-8&quot;)</code></pre>',
    ].join('');
    document.body.appendChild(container);

    decorateFileReferences(container);

    const message = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(message.replace(/^resolve_file_references:/, ''));
    expect(payload.references[0]).toMatchObject({
      pathText: 'registry.py',
      line: 42,
    });
    expect(payload.references[0].contextText).toContain('def _module_registers_tools(module_path: Path) -> bool:');
  });

  it('restores unresolved candidates to their original text', () => {
    window.sendToJava = vi.fn();
    const container = document.createElement('div');
    container.textContent = '接口：Missing.java（第 10 行）';
    document.body.appendChild(container);

    decorateFileReferences(container);

    const message = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(message.replace(/^resolve_file_references:/, ''));

    window.onFileReferenceResolveResult?.(JSON.stringify({
      requestId: payload.requestId,
      results: [{
        id: payload.references[0].id,
        pathText: 'Missing.java',
        line: 10,
        resolved: false,
        reason: 'not_found',
      }],
    }));

    expect(container.querySelector('.file-reference-link')).toBeNull();
    expect(container.querySelector('.file-reference-pending')).toBeNull();
    expect(container.textContent).toBe('接口：Missing.java（第 10 行）');
  });

  it('links inline-code file paths without line numbers', () => {
    window.sendToJava = vi.fn();
    const container = document.createElement('div');
    container.innerHTML = '<p>文件：<code>workstudy-user/.../CommunityCommentLikeRedisMqProducer.java</code></p>';
    document.body.appendChild(container);

    decorateFileReferences(container);

    const message = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(message.replace(/^resolve_file_references:/, ''));
    expect(payload.references[0]).toMatchObject({
      pathText: 'workstudy-user/.../CommunityCommentLikeRedisMqProducer.java',
      line: 0,
    });

    window.onFileReferenceResolveResult?.(JSON.stringify({
      requestId: payload.requestId,
      results: [{
        id: payload.references[0].id,
        pathText: 'workstudy-user/.../CommunityCommentLikeRedisMqProducer.java',
        resolvedPath: 'D:/project/workstudy-user/src/main/java/CommunityCommentLikeRedisMqProducer.java',
        line: 0,
        resolved: true,
      }],
    }));

    const link = container.querySelector('.file-reference-link') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.closest('code')).toBeNull();
    expect(link.textContent).toBe('workstudy-user/.../CommunityCommentLikeRedisMqProducer.java');
    expect(link.title).toBe('D:/project/workstudy-user/src/main/java/CommunityCommentLikeRedisMqProducer.java');
  });

  it('uses an adjacent Chinese line range after an inline-code file path', () => {
    window.sendToJava = vi.fn();
    const container = document.createElement('div');
    container.innerHTML = '<p>文件：<code>CommunityDomainServiceImpl.java</code>（第 862-864 行）</p>';
    document.body.appendChild(container);

    decorateFileReferences(container);

    const message = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(message.replace(/^resolve_file_references:/, ''));
    expect(payload.references[0]).toMatchObject({
      pathText: 'CommunityDomainServiceImpl.java',
      line: 862,
    });

    window.onFileReferenceResolveResult?.(JSON.stringify({
      requestId: payload.requestId,
      results: [{
        id: payload.references[0].id,
        pathText: 'CommunityDomainServiceImpl.java',
        resolvedPath: 'D:/project/src/CommunityDomainServiceImpl.java',
        line: 862,
        resolved: true,
      }],
    }));

    const link = container.querySelector('.file-reference-link') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('CommunityDomainServiceImpl.java（第 862-864 行）');
    expect(link.dataset.line).toBe('862');
    expect(link.title).toBe('D:/project/src/CommunityDomainServiceImpl.java (line 862)');
    expect(container.textContent).toBe('文件：CommunityDomainServiceImpl.java（第 862-864 行）');
  });

  it('treats inline-code Java class names followed by a line range as Java file references', () => {
    window.sendToJava = vi.fn();
    const container = document.createElement('div');
    container.innerHTML = '<p><code>CommunityDomainServiceImpl</code> 第 850-857 行，点赞记录立刻写入数据库。</p>';
    document.body.appendChild(container);

    decorateFileReferences(container);

    const message = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(message.replace(/^resolve_file_references:/, ''));
    expect(payload.references[0]).toMatchObject({
      pathText: 'CommunityDomainServiceImpl.java',
      line: 850,
    });

    window.onFileReferenceResolveResult?.(JSON.stringify({
      requestId: payload.requestId,
      results: [{
        id: payload.references[0].id,
        pathText: 'CommunityDomainServiceImpl.java',
        resolvedPath: 'D:/project/src/CommunityDomainServiceImpl.java',
        line: 850,
        resolved: true,
      }],
    }));

    const link = container.querySelector('.file-reference-link') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('CommunityDomainServiceImpl 第 850-857 行');
    expect(link.dataset.line).toBe('850');
    expect(container.textContent).toBe('CommunityDomainServiceImpl 第 850-857 行，点赞记录立刻写入数据库。');
  });

  it('skips fenced code blocks, existing links, buttons, and URLs', () => {
    window.sendToJava = vi.fn();
    const container = document.createElement('div');
    container.innerHTML = [
      '<p>Real.java:64</p>',
      '<pre><code>Block.java:66</code></pre>',
      '<p><a href="x">Linked.java:67</a></p>',
      '<button>Button.java:68</button>',
      '<p>http://example.com/Url.java:69</p>',
    ].join('');
    document.body.appendChild(container);

    decorateFileReferences(container);

    const pending = Array.from(container.querySelectorAll('.file-reference-pending'));
    expect(pending).toHaveLength(1);
    expect(pending[0].textContent).toBe('Real.java:64');
  });
});

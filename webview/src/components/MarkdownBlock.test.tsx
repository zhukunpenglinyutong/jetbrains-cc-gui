import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import MarkdownBlock from './MarkdownBlock';
import { resetFileReferenceResolutionForTests } from '../utils/fileReferenceLinks';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

describe('MarkdownBlock file reference links', () => {
  beforeEach(() => {
    resetFileReferenceResolutionForTests();
    vi.restoreAllMocks();
    delete window.sendToJava;
    delete window.onFileReferenceResolveResult;
  });

  it('resolves file references and opens the resolved path on click', async () => {
    window.sendToJava = vi.fn();

    render(<MarkdownBlock content="接口：SubjectCategoryController.java (line 64)" />);

    await waitFor(() => expect(window.sendToJava).toHaveBeenCalledTimes(1));
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

    const link = await screen.findByText('SubjectCategoryController.java (line 64)');
    expect(link.classList.contains('file-reference-link')).toBe(true);

    fireEvent.click(link);

    expect(window.sendToJava).toHaveBeenLastCalledWith('open_file:D:/project/src/SubjectCategoryController.java:64');
  });

  it('opens resolved inline-code file references without requiring a line number', async () => {
    window.sendToJava = vi.fn();

    render(<MarkdownBlock content="文件：`workstudy-user/.../CommunityCommentLikeRedisMqProducer.java`" />);

    await waitFor(() => expect(window.sendToJava).toHaveBeenCalledTimes(1));
    const message = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(message.replace(/^resolve_file_references:/, ''));

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

    const link = await screen.findByText('workstudy-user/.../CommunityCommentLikeRedisMqProducer.java');
    expect(link.classList.contains('file-reference-link')).toBe(true);

    fireEvent.click(link);

    expect(window.sendToJava).toHaveBeenLastCalledWith('open_file:D:/project/workstudy-user/src/main/java/CommunityCommentLikeRedisMqProducer.java');
  });

  it('opens the first line of an adjacent Chinese line range', async () => {
    window.sendToJava = vi.fn();

    render(<MarkdownBlock content="文件：`CommunityDomainServiceImpl.java`（第 862-864 行）" />);

    await waitFor(() => expect(window.sendToJava).toHaveBeenCalledTimes(1));
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

    const link = await screen.findByText('CommunityDomainServiceImpl.java（第 862-864 行）');
    fireEvent.click(link);

    expect(window.sendToJava).toHaveBeenLastCalledWith('open_file:D:/project/src/CommunityDomainServiceImpl.java:862');
  });

  it('opens Java class-name references using the adjacent line range first line', async () => {
    window.sendToJava = vi.fn();

    render(<MarkdownBlock content="`CommunityDomainServiceImpl` 第 850-857 行，点赞记录立刻写入数据库。" />);

    await waitFor(() => expect(window.sendToJava).toHaveBeenCalledTimes(1));
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

    const link = await screen.findByText('CommunityDomainServiceImpl 第 850-857 行');
    fireEvent.click(link);

    expect(window.sendToJava).toHaveBeenLastCalledWith('open_file:D:/project/src/CommunityDomainServiceImpl.java:850');
  });
});

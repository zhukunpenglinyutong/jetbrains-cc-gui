import { act, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownReviewBlock } from './MarkdownReviewBlock';
import { encodeReviewMessage, parseReviewMessage } from '../../../utils/markdownReviewMessage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../CollapsibleTextBlock', () => ({ default: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('./CompactSummaryBlock', () => ({ CompactSummaryBlock: () => null }));

it('renders the transmitted selection once, with separate comment and ID, after expanding', async () => {
  const message = parseReviewMessage(encodeReviewMessage([{
    id: 'draft', targetId: 'tab', targetEpoch: 'epoch', path: 'docs/plan.md', documentHash: 'hash',
    annotations: [{ id: '0003', revision: 1, selectedText: 'description="创建分区"\ninputs="分区表现状"',
      sourceText: 'old context', comment: '这两个参数是什么？', startLine: 242, endLine: 243,
      status: 'attached', precision: 'source' }],
  }]))!;
  const { container } = render(<MarkdownReviewBlock {...message} />);
  const details = container.querySelector('details')!;
  await act(async () => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(container.querySelectorAll('blockquote')).toHaveLength(1);
  expect(container.querySelector('blockquote')?.textContent).toBe(message.batches[0].annotations[0].selectedText);
  expect(screen.getByText('这两个参数是什么？')).toBeTruthy();
  expect(screen.getByText('#0003')).toBeTruthy();
  expect(container.querySelectorAll('details')).toHaveLength(1);
  expect(container.querySelector('pre')).toBeNull();
});

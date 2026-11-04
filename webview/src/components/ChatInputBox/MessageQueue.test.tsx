import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { MessageQueue } from './MessageQueue';
import type { QueuedMessage } from '../../hooks/useMessageQueue';
import type { Attachment } from './types';

const t = ((key: string, options?: Record<string, unknown>) =>
  typeof options?.position === 'number' ? `${key}:${options.position}` : key) as unknown as TFunction;

const attachment: Attachment = { id: 'att-1', fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' };

const createQueue = (): QueuedMessage[] => [
  { id: 'q-1', content: 'first message', queuedAt: 1 },
  { id: 'q-2', content: 'second message', attachments: [attachment], queuedAt: 2 },
];

describe('MessageQueue', () => {
  it('renders an edit button for every queued message and reports the edited id', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<MessageQueue queue={createQueue()} onRemove={onRemove} onEdit={onEdit} t={t} />);

    // Rows render in reverse queue order, so the first button belongs to q-2 —
    // the message closest to the input (the acceptance-scenario "second" item).
    const editButtons = screen.getAllByTitle('chat.queue.edit');
    expect(editButtons).toHaveLength(2);

    fireEvent.click(editButtons[0]);

    expect(onEdit).toHaveBeenCalledExactlyOnceWith('q-2');
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('keeps the remove button wired to its own callback', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<MessageQueue queue={createQueue()} onRemove={onRemove} onEdit={onEdit} t={t} />);

    fireEvent.click(screen.getAllByTitle('chat.queue.remove')[1]);

    expect(onRemove).toHaveBeenCalledExactlyOnceWith('q-1');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('hides the edit action when no edit handler is wired', () => {
    render(<MessageQueue queue={createQueue()} onRemove={vi.fn()} t={t} />);

    expect(screen.queryAllByTitle('chat.queue.edit')).toHaveLength(0);
    // The remove action stays available, so the row is still usable.
    expect(screen.getAllByTitle('chat.queue.remove')).toHaveLength(2);
  });

  it('exposes accessible names and non-submit buttons', () => {
    render(<MessageQueue queue={createQueue()} onRemove={vi.fn()} onEdit={vi.fn()} t={t} />);

    const edit = screen.getAllByTitle('chat.queue.edit')[0];
    // The name carries the row's position so a screen reader can tell rows apart.
    expect(edit.getAttribute('aria-label')).toBe('chat.queue.editLabel:2');
    expect(edit.getAttribute('type')).toBe('button');
    expect(screen.getAllByTitle('chat.queue.remove').map(button => button.getAttribute('aria-label')))
      .toEqual(['chat.queue.removeLabel:2', 'chat.queue.removeLabel:1']);
    // Icon-only buttons must not rely on the icon font for their name.
    expect(edit.querySelector('.codicon-edit')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows nothing while the queue is empty', () => {
    const { container } = render(<MessageQueue queue={[]} onRemove={vi.fn()} onEdit={vi.fn()} t={t} />);

    expect(container.querySelector('.message-queue')).toBeNull();
  });
});

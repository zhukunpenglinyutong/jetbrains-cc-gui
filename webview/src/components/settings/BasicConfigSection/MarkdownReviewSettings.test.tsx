import { act, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownReviewSettings } from './MarkdownReviewSettings';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => { delete window.sendToJava; });

it('saves and restores the independent comment submit shortcut', () => {
  window.sendToJava = vi.fn();
  render(<MarkdownReviewSettings />);
  const select = screen.getByRole('combobox', { name: 'markdownReview.settings.submitShortcut.label' });
  expect((select as HTMLSelectElement).value).toBe('enter');
  fireEvent.change(select, { target: { value: 'ctrlEnter' } });
  expect(window.sendToJava).toHaveBeenLastCalledWith('set_markdown_review_config:{"submitShortcut":"ctrlEnter"}');
  act(() => window.setMarkdownReviewConfig!(JSON.stringify({ enabled: true, autoAddToChat: true,
    autoDeleteAffected: true, persist: false, submitShortcut: 'ctrlEnter' })));
  expect((select as HTMLSelectElement).value).toBe('ctrlEnter');
  expect((select as HTMLSelectElement).disabled).toBe(false);
});

it('loads authoritative preferences and sends one-field updates, including persistence', () => {
  window.sendToJava = vi.fn();
  const { unmount } = render(<MarkdownReviewSettings />);
  expect(window.sendToJava).toHaveBeenCalledWith('get_markdown_review_config:');
  act(() => window.setMarkdownReviewConfig!(JSON.stringify({ enabled: false, autoAddToChat: false, autoDeleteAffected: false, persist: false })));
  const enabled = screen.getByRole('checkbox', { name: 'markdownReview.settings.enabled.label' }) as HTMLInputElement;
  expect(enabled.checked).toBe(false);
  fireEvent.click(enabled);
  expect(window.sendToJava).toHaveBeenLastCalledWith('set_markdown_review_config:{"enabled":true}');
  expect(enabled.disabled).toBe(true);
  act(() => window.setMarkdownReviewConfig!(JSON.stringify({ enabled: true, autoAddToChat: false, autoDeleteAffected: false, persist: false })));
  expect(enabled.checked).toBe(true);
  const auto = screen.getByRole('checkbox', { name: 'markdownReview.settings.autoAddToChat.label' });
  fireEvent.click(auto);
  expect(window.sendToJava).toHaveBeenLastCalledWith('set_markdown_review_config:{"autoAddToChat":true}');
  act(() => window.setMarkdownReviewConfig!(JSON.stringify({ enabled: true, autoAddToChat: true, autoDeleteAffected: false, persist: false })));
  fireEvent.click(screen.getByRole('checkbox', { name: 'markdownReview.settings.persist.label' }));
  expect(window.sendToJava).toHaveBeenLastCalledWith('set_markdown_review_config:{"persist":true}');
  unmount();
  expect(window.setMarkdownReviewConfig).toBeUndefined();
});

it('retains the backend preference after a rejected update and shows an error', () => {
  window.sendToJava = vi.fn();
  render(<MarkdownReviewSettings />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'markdownReview.settings.autoDeleteAffected.label' }));
  act(() => window.setMarkdownReviewConfig!(JSON.stringify({ enabled: true, autoAddToChat: false, autoDeleteAffected: true, persist: false, error: 'rejected' })));
  expect(screen.getByRole('alert').textContent).toBe('markdownReview.settings.error');
  expect((screen.getByRole('checkbox', { name: 'markdownReview.settings.autoDeleteAffected.label' }) as HTMLInputElement).checked).toBe(true);
});

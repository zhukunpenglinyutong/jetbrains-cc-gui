import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CodexQuestionBlock } from './CodexQuestionBlock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

it('displays a read-only question and answer without raw protocol text or HTML execution', () => {
  render(<CodexQuestionBlock input={{ questions: [{ id: 'q', question: 'Choose a test answer.',
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }], answers: { q: '<script>custom answer</script>' } }} />);
  expect(screen.getByText('Choose a test answer.')).toBeTruthy();
  expect(screen.getByText('B')).toBeTruthy();
  expect(screen.getByText('<script>custom answer</script>', { exact: false })).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(document.querySelector('button, input, textarea')).toBeNull();
  expect(screen.getByText('Request User Input Async')).toBeTruthy();
  expect(screen.queryByText('Codex questions')).toBeNull();
});

it('uses ordinary markdown for multiple questions and keeps structured option labels and descriptions literal', () => {
  const { container } = render(<CodexQuestionBlock input={{ questions: [
    { id: 'mode', question: 'Choose **one** mode for `config.toml`.', options: [
      { label: 'A', description: 'Use the existing settings.' },
      { label: '<script>option</script>', description: '<img src=x onerror=alert(1)>' },
    ] },
    { id: 'comment', question: 'Any extra **details**?', options: [] },
  ] }} />);
  expect(container.querySelectorAll('.markdown-content strong')).toHaveLength(2);
  expect(container.querySelector('.markdown-content code')?.textContent).toBe('config.toml');
  expect(screen.getAllByRole('listitem').map(item => item.textContent?.trim())).toEqual([
    'A — Use the existing settings.', '<script>option</script> — <img src=x onerror=alert(1)>',
  ]);
  expect(container.querySelector('script, img')).toBeNull();
  expect(screen.getAllByText('Request User Input Async')).toHaveLength(1);
  expect(container.querySelector('.task-details-accordion')).toBeNull();
});

it('shows a later custom answer beside the original question without making the transcript an answer form', () => {
  const questions = [{ id: 'q', question: 'Choose a test answer.', options: [{ label: 'A' }] }];
  const { container, rerender } = render(<CodexQuestionBlock input={{ questions }} />);
  expect(container.querySelector('.codex-question-record-answer')).toBeNull();
  rerender(<CodexQuestionBlock input={{ questions, answers: { q: 'First line\n<script>second line</script>' } }} />);
  expect(container.querySelector('.codex-question-record-answer')?.textContent).toBe(
    'Your answer: First line\n<script>second line</script>',
  );
  expect(screen.getByText('Choose a test answer.')).toBeTruthy();
  expect(container.querySelector('button, input, textarea, script')).toBeNull();
});

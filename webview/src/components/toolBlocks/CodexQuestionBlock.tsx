import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { CODEX_QUESTION_DISMISSED, transcriptQuestions } from '../../utils/codexQuestionTranscript';
import MarkdownBlock from '../MarkdownBlock';
import GenericToolBlock from './GenericToolBlock';
import './CodexQuestionBlock.css';

const QUESTION_RECEIPT_INPUT: ToolInput = {};
// This receipt marks publication of the question; its answer is displayed below.
const QUESTION_RECEIPT_RESULT: ToolResultBlock = { type: 'tool_result', content: '' };

export const CodexQuestionBlock = memo(function CodexQuestionBlock({ input }: { input?: ToolInput }) {
  const { t } = useTranslation();
  const questions = transcriptQuestions(input);
  if (!questions.length) return null;
  const answers = input?.answers && typeof input.answers === 'object'
    ? input.answers as Record<string, unknown> : {};
  return (
    <section className="codex-question-record" aria-label={t('askUserQuestion.recordTitle', 'Codex questions')}>
      <GenericToolBlock name="request_user_input_async" input={QUESTION_RECEIPT_INPUT} result={QUESTION_RECEIPT_RESULT} />
      {questions.map(question => {
        const answer = answers[question.id];
        return (
          <div className="codex-question-record-item" key={question.id}>
            <MarkdownBlock content={question.question} />
            {question.options.length > 0 && (
              <div className="markdown-content">
                <ul>{question.options.map((option, index) => (
                  <li key={`${index}:${option.label}`}>
                    {option.label}{option.description ? <> — {option.description}</> : null}
                  </li>
                ))}</ul>
              </div>
            )}
            {typeof answer === 'string' && <div className="codex-question-record-answer">
              <strong>{t('askUserQuestion.recordAnswer', 'Your answer')}: </strong>
              {answer === CODEX_QUESTION_DISMISSED
                ? t('askUserQuestion.recordSkipped', 'Skipped (closed without an answer)') : answer}
            </div>}
          </div>
        );
      })}
    </section>
  );
});

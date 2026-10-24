/** Async questions are agent messages, not JSON-RPC reverse requests (Codex 0.163). */
export const ASYNC_QUESTION_METHOD = 'item/agentMessage/requestUserInput';

export function normalizeAsyncQuestions(item) {
  if (item?.type !== 'agentMessage' || item.delivery !== 'async' || !Array.isArray(item.questions)) return [];
  return item.questions.flatMap((question, index) => {
    if (typeof question?.title !== 'string' || !question.title.trim()) return [];
    return [{
      id: `question-${index + 1}`, header: '', question: question.title, multiSelect: false,
      options: Array.isArray(question.options)
        ? question.options.filter(option => typeof option === 'string' && option.trim())
          .map(label => ({ label, description: '' })) : [],
    }];
  });
}

/** Only explicit, typed answers to this question may become user input. */
export function asyncQuestionAnswer(questions, result, itemId = null) {
  const answers = result?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  if (Object.keys(answers).length === 0) return '';
  const ids = new Set(questions.map(question => question.id));
  if (Object.keys(answers).some(id => !ids.has(id))) return null;
  const lines = [];
  for (const question of questions) {
    const values = answers[question.id]?.answers;
    if (!Array.isArray(values) || values.length === 0
        || values.some(value => typeof value !== 'string' || !value.trim())) return null;
    lines.push(`${question.question}\n${values.join(', ')}`);
  }
  // A prefix also prevents an answer such as /new from being parsed as a local command.
  const request = typeof itemId === 'string' && itemId ? ` (request: ${encodeURIComponent(itemId)})` : '';
  return `Answers to your questions${request}:\n\n${lines.join('\n\n')}`;
}

import type { Question, QuestionOption } from '../AskUserQuestionDialog';

export function normalizeQuestion(raw: any): Question | null {
  if (!raw || typeof raw !== 'object') return null;
  const questionText = typeof raw.question === 'string' ? raw.question : (typeof raw.text === 'string' ? raw.text : '');
  const header = typeof raw.header === 'string' ? raw.header : '';
  const multiSelect = typeof raw.multiSelect === 'boolean' ? raw.multiSelect : false;
  const rawOptions = Array.isArray(raw.options) ? raw.options : (Array.isArray(raw.choices) ? raw.choices : []);
  const options: QuestionOption[] = rawOptions.flatMap((opt: any): QuestionOption[] => {
    if (typeof opt === 'string') return [{ label: opt, description: '' }];
    if (!opt || typeof opt !== 'object') return [];
    const label = typeof opt.label === 'string' ? opt.label : (typeof opt.value === 'string' ? opt.value : '');
    const description = typeof opt.description === 'string' ? opt.description : '';
    if (!label) return [];
    return [{ label, description }];
  });
  if (!questionText) return null;
  return { question: questionText, header, options, multiSelect };
}

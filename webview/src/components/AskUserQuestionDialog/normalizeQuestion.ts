import type { Question, QuestionIntent, QuestionOption } from '../AskUserQuestionDialog';

/** Carry a caller-declared presentation intent through to the dialog. */
function normalizeIntent(raw: any): QuestionIntent | undefined {
  if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string' || !raw.kind) {
    return undefined;
  }
  return {
    kind: raw.kind,
    ...(typeof raw.approve === 'string' && raw.approve ? { approve: raw.approve } : {}),
  };
}

export function normalizeQuestion(raw: any): Question | null {
  if (!raw || typeof raw !== 'object') return null;
  const questionText = typeof raw.question === 'string' ? raw.question : (typeof raw.text === 'string' ? raw.text : '');
  const header = typeof raw.header === 'string' ? raw.header : '';
  const multiSelect = typeof raw.multiSelect === 'boolean' ? raw.multiSelect : false;
  const detail = typeof raw.detail === 'string' ? raw.detail : '';
  const intent = normalizeIntent(raw.intent);
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
  // `detail` (DSH's plan under review) and `intent` are part of the question,
  // not decoration: dropping them made a plan-review unanswerable in cc-gui.
  return {
    question: questionText,
    header,
    options,
    multiSelect,
    ...(detail ? { detail } : {}),
    ...(intent ? { intent } : {}),
  };
}

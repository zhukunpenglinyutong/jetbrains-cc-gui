import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { stripAnsi } from '../../utils/stripAnsi';

interface UseBashToolStateArgs {
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
}

export function useBashToolState({ input, result, toolId }: UseBashToolStateArgs) {
  const isDenied = useIsToolDenied(toolId);

  const command = typeof input?.command === 'string' ? input.command : '';
  const description = typeof input?.description === 'string' ? input.description : '';

  // Determine tool call status based on result
  // If denied, treat as completed (show error state)
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  // If denied, show as error state
  const isError = isDenied || (isCompleted && result?.is_error === true);

  let output = '';

  if (result) {
    const content = result.content;
    if (typeof content === 'string') {
      output = content;
    } else if (Array.isArray(content)) {
      output = content.map((block) => block.text ?? '').join('\n');
    }
    output = stripAnsi(output);
  }

  return { command, description, isCompleted, isError, output };
}

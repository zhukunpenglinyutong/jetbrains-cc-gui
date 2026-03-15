import type { ClaudeRawMessage } from '../../types';

interface MessageUsageProps {
  raw?: ClaudeRawMessage | string;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return String(n);
}

export const MessageUsage = ({ raw }: MessageUsageProps) => {
  if (!raw || typeof raw === 'string') return null;

  const usage = (raw.message as Record<string, unknown>)?.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    | undefined;

  if (!usage) return null;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  if (input === 0 && output === 0) return null;

  const cacheTotal = cacheRead + cacheWrite;
  const inputPart = cacheTotal > 0
    ? `${formatTokenCount(input)} in (${formatTokenCount(cacheTotal)} cached)`
    : `${formatTokenCount(input)} in`;

  return (
    <div className="message-usage">
      {inputPart} / {formatTokenCount(output)} out
    </div>
  );
};

export default MessageUsage;

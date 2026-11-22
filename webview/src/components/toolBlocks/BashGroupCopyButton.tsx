import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../../utils/copyUtils';

interface BashGroupCopyButtonProps {
  text: string;
  label: string;
}

/** How long the check mark stays after a successful copy */
const COPIED_FEEDBACK_MS = 1200;

/**
 * Icon-only copy button for batch command rows. Clicks do not bubble to the
 * message list, matching the row toggle beside it.
 */
export default function BashGroupCopyButton({ text, label }: BashGroupCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!(await copyToClipboard(text))) return;
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <button
      type="button"
      className={`bash-group-copy ${copied ? 'copied' : ''}`}
      title={label}
      aria-label={label}
      onClick={handleClick}
    >
      <span className={`codicon ${copied ? 'codicon-check' : 'codicon-copy'}`} />
    </button>
  );
}

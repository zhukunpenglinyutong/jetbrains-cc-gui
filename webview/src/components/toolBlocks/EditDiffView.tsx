type DiffLineType = 'unchanged' | 'deleted' | 'added';

interface DiffLine {
  type: DiffLineType;
  content: string;
}

export interface DiffResult {
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

const TASK_DETAILS_STYLE: React.CSSProperties = {
  padding: 0,
  borderTop: '1px solid var(--border-primary)',
};

const DIFF_CONTAINER_STYLE: React.CSSProperties = {
  // Use monospace font to ensure consistent tab and space widths. Declaring it on
  // the container alone is not enough: the global `* { font-family }` UI-font rule
  // in base.less matches every descendant directly and beats inheritance, so the
  // container also carries the .code-font-surface class (see base.less) to push the
  // code font back onto all of them.
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontSize: '12px',
  lineHeight: 1.5,
  background: 'var(--diff-surface)',
  // Normalize tab width to prevent indentation shifts across environments
  tabSize: 4 as unknown as number,
  MozTabSize: 4 as unknown as number,
  // Preserve whitespace and line breaks without wrapping to prevent reflow during selection
  whiteSpace: 'pre' as const,
  // Horizontal scroll only to avoid jitter from simultaneous horizontal and vertical changes
  overflowX: 'auto' as const,
  overflowY: 'hidden' as const,
  // Hint the browser to promote this container to a compositing layer for better selection performance
  willChange: 'transform' as const,
  transform: 'translateZ(0)',
};

const INNER_WRAPPER_STYLE: React.CSSProperties = {
  display: 'inline-block',
  minWidth: '100%',
};

const DIFF_PRE_STYLE: React.CSSProperties = {
  // Preserve original whitespace with consistent tab width
  whiteSpace: 'pre',
  margin: 0,
  paddingLeft: '4px',
  flex: 1,
  // Re-declare tabSize in case highlight or wrapper layers override it
  tabSize: 4 as unknown as number,
  MozTabSize: 4 as unknown as number,
  // Disable arbitrary line breaks to keep selection and scrolling stable
  overflowWrap: 'normal' as const,
};

function getDiffLineStyle(isDeleted: boolean, isAdded: boolean): React.CSSProperties {
  return {
    display: 'flex',
    background: isDeleted
      ? 'var(--diff-deleted-bg)'
      : isAdded
        ? 'var(--diff-added-bg)'
        : 'transparent',
    color: 'var(--diff-text)',
    minWidth: '100%',
  };
}

function getDiffGlyphStyle(isDeleted: boolean, isAdded: boolean, isUnchanged: boolean): React.CSSProperties {
  return {
    width: '24px',
    textAlign: 'center',
    color: isDeleted ? 'var(--diff-deleted-accent)' : isAdded ? 'var(--diff-added-accent)' : 'var(--diff-muted-text)',
    userSelect: 'none',
    background: isDeleted
      ? 'var(--diff-deleted-glyph-bg)'
      : isAdded
        ? 'var(--diff-added-glyph-bg)'
        : 'transparent',
    opacity: isUnchanged ? 0.5 : 0.7,
    flex: '0 0 24px',
  };
}

// Compute actual diff using the LCS algorithm
export function computeDiff(oldLines: string[], newLines: string[]): DiffResult {
  if (oldLines.length === 0 && newLines.length === 0) {
    return { lines: [], additions: 0, deletions: 0 };
  }
  if (oldLines.length === 0) {
    return {
      lines: newLines.map(content => ({ type: 'added' as const, content })),
      additions: newLines.length,
      deletions: 0,
    };
  }
  if (newLines.length === 0) {
    return {
      lines: oldLines.map(content => ({ type: 'deleted' as const, content })),
      additions: 0,
      deletions: oldLines.length,
    };
  }

  const m = oldLines.length;
  const n = newLines.length;

  // Build the LCS dynamic programming table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to generate the diff
  const diffLines: DiffLine[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffLines.unshift({ type: 'unchanged', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.unshift({ type: 'added', content: newLines[j - 1] });
      j--;
    } else {
      diffLines.unshift({ type: 'deleted', content: oldLines[i - 1] });
      i--;
    }
  }

  const additions = diffLines.filter(l => l.type === 'added').length;
  const deletions = diffLines.filter(l => l.type === 'deleted').length;

  return { lines: diffLines, additions, deletions };
}

interface EditDiffViewProps {
  diff: DiffResult;
}

const EditDiffView = function EditDiffView({ diff }: EditDiffViewProps) {
  return (
    <div className="task-details" style={TASK_DETAILS_STYLE}>
      <div className="code-font-surface" style={DIFF_CONTAINER_STYLE}>
        {/* Inner wrapper stretches to scrollWidth so row backgrounds fill the full width */}
        <div style={INNER_WRAPPER_STYLE}>
        {diff.lines.map((line, index) => {
          const isDeleted = line.type === 'deleted';
          const isAdded = line.type === 'added';
          const isUnchanged = line.type === 'unchanged';

          return (
            <div
              key={index}
              style={getDiffLineStyle(isDeleted, isAdded)}
            >
              <div style={getDiffGlyphStyle(isDeleted, isAdded, isUnchanged)}>
                {isDeleted ? '-' : isAdded ? '+' : ' '}
              </div>
              <pre style={DIFF_PRE_STYLE}>
                {line.content}
              </pre>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
};

export default EditDiffView;

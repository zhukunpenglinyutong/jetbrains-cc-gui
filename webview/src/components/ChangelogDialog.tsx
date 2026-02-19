import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChangelogEntry } from '../version/changelog';

interface ChangelogDialogProps {
  isOpen: boolean;
  onClose: () => void;
  entries: ChangelogEntry[];
  initialPage?: number;
}

/**
 * Resolve content to display. Shows both EN and ZH when both exist,
 * otherwise shows whichever is available.
 */
function resolveContent(entry: ChangelogEntry): string[] {
  const { en, zh } = entry.content;
  const parts: string[] = [];
  if (en) parts.push(en);
  if (zh) parts.push(zh);
  return parts;
}

/**
 * Simple markdown-to-HTML renderer for changelog content.
 * Handles: headings, bullet lists, bold, inline code, and emoji.
 */
function renderChangelogMarkdown(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  const htmlParts: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (inList) {
        htmlParts.push('</ul>');
        inList = false;
      }
      continue;
    }

    // Bullet list item
    if (trimmed.startsWith('- ')) {
      if (!inList) {
        htmlParts.push('<ul>');
        inList = true;
      }
      const itemText = escapeHtml(trimmed.substring(2)).replace(
        /`([^`]+)`/g,
        '<code>$1</code>'
      );
      htmlParts.push(`<li>${itemText}</li>`);
      continue;
    }

    // Close list if not a bullet item
    if (inList) {
      htmlParts.push('</ul>');
      inList = false;
    }

    // Section heading (emoji prefix like ✨ Features, 🐛 Fixes, 🔧 Improvements)
    if (/^[✨🐛🔧🎉🚀💡⚡️🔥📦🛠️]/.test(trimmed)) {
      htmlParts.push(`<h4>${escapeHtml(trimmed)}</h4>`);
      continue;
    }

    // Priority label lines (P0/P1/P2 format from older changelogs)
    if (/^P\d/.test(trimmed)) {
      if (!inList) {
        htmlParts.push('<ul>');
        inList = true;
      }
      htmlParts.push(`<li>${escapeHtml(trimmed)}</li>`);
      continue;
    }

    // Plain text
    htmlParts.push(`<p>${escapeHtml(trimmed)}</p>`);
  }

  if (inList) {
    htmlParts.push('</ul>');
  }

  return htmlParts.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ChangelogDialog = ({ isOpen, onClose, entries, initialPage = 0 }: ChangelogDialogProps) => {
  const { t } = useTranslation();
  const [currentPage, setCurrentPage] = useState(initialPage);

  // Reset page when dialog opens
  useEffect(() => {
    if (isOpen) {
      setCurrentPage(initialPage);
    }
  }, [isOpen, initialPage]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
        setCurrentPage(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowRight') {
        setCurrentPage(prev => Math.min(entries.length - 1, prev + 1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, entries.length, onClose]);

  const handlePrev = useCallback(() => {
    setCurrentPage(prev => Math.max(0, prev - 1));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentPage(prev => Math.min(entries.length - 1, prev + 1));
  }, [entries.length]);

  if (!isOpen || entries.length === 0) return null;

  const entry = entries[currentPage];
  const contentParts = resolveContent(entry);
  const totalPages = entries.length;
  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;

  return (
    <div className="changelog-overlay">
      <div className="changelog-dialog">
        {/* Header */}
        <div className="changelog-header">
          <div className="changelog-title-area">
            <h3>{t('changelog.title')}</h3>
            <span className="changelog-version-badge">v{entry.version}</span>
          </div>
          <button className="changelog-close-btn" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        {/* Body */}
        <div className="changelog-body">
          <div className="changelog-date">{entry.date}</div>
          {contentParts.map((part, idx) => (
            <div key={idx}>
              {idx > 0 && <hr className="changelog-divider" />}
              <div
                className="changelog-content"
                dangerouslySetInnerHTML={{ __html: renderChangelogMarkdown(part) }}
              />
            </div>
          ))}
        </div>

        {/* Footer with pagination */}
        <div className="changelog-footer">
          <button
            className="changelog-nav-btn"
            onClick={handlePrev}
            disabled={!hasPrev}
            aria-label="Previous version"
          >
            <span className="codicon codicon-chevron-left" />
          </button>

          <div className="changelog-pagination">
            {totalPages <= 10 ? (
              <div className="changelog-dots">
                {entries.map((_, idx) => (
                  <button
                    key={idx}
                    className={`changelog-dot ${idx === currentPage ? 'active' : ''}`}
                    onClick={() => setCurrentPage(idx)}
                    aria-label={`Page ${idx + 1}`}
                  />
                ))}
              </div>
            ) : (
              <span className="changelog-page-text">
                {t('changelog.page', { current: currentPage + 1, total: totalPages })}
              </span>
            )}
          </div>

          <button
            className="changelog-nav-btn"
            onClick={handleNext}
            disabled={!hasNext}
            aria-label="Next version"
          >
            <span className="codicon codicon-chevron-right" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChangelogDialog;

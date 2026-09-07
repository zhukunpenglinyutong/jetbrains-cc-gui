import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChangelogEntry } from '../version/changelog';
import { openBrowser, GITHUB_REPO_URL } from '../utils/bridge';
interface ChangelogDialogProps {
  isOpen: boolean;
  onClose: () => void;
  entries: ChangelogEntry[];
  initialPage?: number;
}

/**
 * Whether the UI language should prefer Chinese changelog content first.
 * Covers simplified (`zh`) and traditional (`zh-TW`) locales.
 */
function prefersChineseChangelog(language: string | undefined): boolean {
  if (!language) return false;
  return language === 'zh' || language === 'zh-TW' || language.startsWith('zh-') || language.startsWith('zh_');
}

/**
 * Resolve content to display. Shows both EN and ZH when both exist,
 * ordered by the active UI language (Chinese first for zh / zh-TW).
 */
function resolveContent(entry: ChangelogEntry, language?: string): string[] {
  const { en, zh } = entry.content;
  const parts: string[] = [];
  if (prefersChineseChangelog(language)) {
    if (zh) parts.push(zh);
    if (en) parts.push(en);
  } else {
    if (en) parts.push(en);
    if (zh) parts.push(zh);
  }
  return parts;
}

const INLINE_CODE_RE = /`([^`]+)`/g;
const BOLD_ITALIC_RE = /\*\*\*([^*]+)\*\*\*/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;

/**
 * Apply inline markdown formatting: inline code, bold, italic, and bold-italic.
 * Must run after HTML escaping, which preserves `*` and backticks. The emphasis
 * patterns are matched longest-first so `***x***` is not swallowed by `**`/`*`.
 */
function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(INLINE_CODE_RE, '<code>$1</code>')
    .replace(BOLD_ITALIC_RE, '<strong><em>$1</em></strong>')
    .replace(BOLD_RE, '<strong>$1</strong>')
    .replace(ITALIC_RE, '<em>$1</em>');
}

/**
 * Simple markdown-to-HTML renderer for changelog content.
 * Handles: headings, bullet lists, bold, italic, inline code, and emoji.
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
      htmlParts.push(`<li>${renderInline(trimmed.substring(2))}</li>`);
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
    htmlParts.push(`<p>${renderInline(trimmed)}</p>`);
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
  const { t, i18n } = useTranslation();
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
  const contentParts = resolveContent(entry, i18n.language);
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
            <span className="changelog-date">{entry.date}</span>
          </div>
          <button className="changelog-close-btn" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        {/* Open source banner (reuses the chat header banner styles) */}
        <div className="open-source-banner">
          <span className="banner-text">{t('chat.openSourceBanner')}</span>
          <button
            type="button"
            className="banner-star"
            aria-label={t('chat.openSourceBannerStarAria')}
            onClick={() => openBrowser(GITHUB_REPO_URL)}
          >
            <svg className="star-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
            </svg>
            <span className="banner-star-text">{t('chat.openSourceBannerStar')}</span>
          </button>
        </div>

        {/* Body */}
        <div className="changelog-body">
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

/**
 * F-007: Bug report dropdown for diagnostic snapshots.
 * Shows a filterable list of known bugs loaded on demand from TRACKER.md via Java.
 * Selecting one triggers a snapshot.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KnownBug } from '../../diagnostics/knownBugs';
import { sendBridgeEvent } from '../../utils/bridge';

interface BugDropdownProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onSelect: (bugId: string) => void;
  onClose: () => void;
}

export function BugDropdown({ open, anchorRef, onSelect, onClose }: BugDropdownProps) {
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [bugs, setBugs] = useState<KnownBug[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Request bugs from Java when dropdown opens
  useEffect(() => {
    if (!open) return;

    setFilter('');
    setActiveIndex(0);
    setLoading(true);

    // Register one-shot callback for Java response
    window.setKnownBugs = (json: string) => {
      try {
        const parsed: KnownBug[] = JSON.parse(json);
        setBugs(parsed);
      } catch { /* ignore malformed response */ }
      setLoading(false);
    };

    sendBridgeEvent('get_known_bugs');

    // Timeout fallback
    const timeout = setTimeout(() => {
      setLoading(false);
    }, 3000);

    // Focus input after DOM render
    requestAnimationFrame(() => inputRef.current?.focus());

    return () => {
      clearTimeout(timeout);
      delete window.setKnownBugs;
    };
  }, [open]);

  // Filter bugs locally
  const filtered = useMemo(() => {
    if (!filter.trim()) return bugs.slice(0, 10);
    const q = filter.toLowerCase();
    return bugs
      .filter(b => b.id.toLowerCase().includes(q) || b.label.toLowerCase().includes(q))
      .slice(0, 10);
  }, [bugs, filter]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current && !dropdownRef.current.contains(target) &&
        anchorRef.current && !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, onClose, anchorRef]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(prev => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIndex]) {
        onSelect(filtered[activeIndex].id);
        onClose();
      }
    }
  }, [filtered, activeIndex, onSelect, onClose]);

  const handleSelect = useCallback((bug: KnownBug) => {
    onSelect(bug.id);
    onClose();
  }, [onSelect, onClose]);

  if (!open) return null;

  return (
    <div className="bug-dropdown" ref={dropdownRef} onKeyDown={handleKeyDown}>
      <input
        ref={inputRef}
        className="bug-dropdown-filter"
        type="text"
        value={filter}
        onChange={e => { setFilter(e.target.value); setActiveIndex(0); }}
        placeholder="Filter bugs..."
        spellCheck={false}
      />
      <div className="bug-dropdown-list">
        {loading ? (
          <div className="bug-dropdown-empty">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="bug-dropdown-empty">No matching bugs</div>
        ) : (
          filtered.map((bug, i) => (
            <div
              key={bug.id}
              className={`bug-dropdown-item${i === activeIndex ? ' active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => handleSelect(bug)}
            >
              <span className={`bug-dropdown-item-id${bug.status === 'testing' ? ' testing' : ''}`}>{bug.id}</span>
              <span className="bug-dropdown-item-label">{bug.label}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

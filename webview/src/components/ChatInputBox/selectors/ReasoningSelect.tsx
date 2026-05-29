import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  REASONING_LEVELS,
  EFFORT_SUPPORTED_CLAUDE_MODELS,
  MAX_EFFORT_CLAUDE_MODELS,
  XHIGH_EFFORT_CLAUDE_MODELS,
} from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const LEVEL_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1 };

type ReasoningLevelOption = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
};

interface ReasoningSelectProps {
  value: string;
  onChange: (effort: string) => void;
  disabled?: boolean;
  selectedModel?: string;
  currentProvider?: string;
  openCodeVariantOptions?: Array<{ id: string; label: string }>;
}

/**
 * ReasoningSelect - Reasoning Effort Selector
 * Controls the depth of reasoning for AI models.
 * Visibility and available levels depend on the selected model:
 * - Codex: low/medium/high/xhigh
 * - Claude Opus 4.7: low/medium/high/xhigh/max
 * - Claude Opus 4.6 and Sonnet 4.6: low/medium/high/max
 * - Claude Haiku 4.5 and legacy models: hidden (no adaptive thinking support)
 * - OpenCode: model variant keys from opencode discovery (thinking effort), when available
 */
export const ReasoningSelect = ({
  value,
  onChange,
  disabled,
  selectedModel,
  currentProvider,
  openCodeVariantOptions,
}: ReasoningSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isOpenCode = currentProvider === 'opencode';
  const openCodeLevels: ReasoningLevelOption[] = (openCodeVariantOptions ?? []).map((option) => ({
    id: option.id,
    label: option.label,
    description: option.id === 'default'
      ? 'Use model default thinking effort'
      : `${option.label} thinking effort`,
    icon: 'codicon-lightbulb',
  }));

  const isVisible = isOpenCode
    ? openCodeLevels.length > 0
    : currentProvider === 'codex'
      || (currentProvider === 'claude' && (!selectedModel || EFFORT_SUPPORTED_CLAUDE_MODELS.has(selectedModel)));

  const availableLevels: ReasoningLevelOption[] = isOpenCode
    ? openCodeLevels
    : REASONING_LEVELS.filter(level => {
      if (currentProvider !== 'claude') {
        return level.id !== 'max';
      }
      if (!selectedModel) {
        return true;
      }
      if (level.id === 'xhigh') {
        return XHIGH_EFFORT_CLAUDE_MODELS.has(selectedModel);
      }
      if (level.id === 'max') {
        return MAX_EFFORT_CLAUDE_MODELS.has(selectedModel);
      }
      return true;
    });

  const currentLevel = availableLevels.find(l => l.id === value)
    || availableLevels[availableLevels.length - 2]
    || availableLevels[0];
  const { positionedStyle, maxHeight: viewportMaxHeight, recalculate } = useDropdownPosition({
    buttonRef,
    preferredAlignment: 'right',
    minWidth: 240,
  });

  useEffect(() => {
    if (!isVisible || availableLevels.some(level => level.id === value)) {
      return;
    }
    if (currentLevel) {
      onChange(currentLevel.id);
    }
  }, [availableLevels, currentLevel, isVisible, onChange, value]);

  const getReasoningText = (levelId: string, field: 'label' | 'description') => {
    if (isOpenCode) {
      const option = openCodeLevels.find((level) => level.id === levelId);
      if (field === 'label') {
        return option?.label ?? levelId;
      }
      return option?.description ?? levelId;
    }
    const key = `reasoning.${levelId}.${field}`;
    const fallback = REASONING_LEVELS.find(l => l.id === levelId)?.[field] || levelId;
    return t(key, { defaultValue: fallback });
  };

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    const next = !isOpen;
    setIsOpen(next);
    if (next) {
      recalculate();
    }
  }, [isOpen, disabled, recalculate]);

  const handleSelect = useCallback((effort: string) => {
    onChange(effort);
    setIsOpen(false);
  }, [onChange]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  if (!isVisible) return null;

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        disabled={disabled}
        title={t('reasoning.title', { defaultValue: 'Select reasoning depth' })}
      >
        <span className="codicon codicon-lightbulb" />
        <span className="selector-button-text">{getReasoningText(currentLevel.id, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...positionedStyle, maxHeight: viewportMaxHeight ? `${viewportMaxHeight}px` : undefined, overflowY: 'auto' }}
        >
          {availableLevels.map((level) => (
            <div
              key={level.id}
              className={`selector-option ${level.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(level.id)}
              title={getReasoningText(level.id, 'description')}
            >
              <span className={`codicon ${level.icon ?? 'codicon-lightbulb'}`} />
              <div style={LEVEL_INFO_STYLE}>
                <span>{getReasoningText(level.id, 'label')}</span>
                <span className="mode-description">{getReasoningText(level.id, 'description')}</span>
              </div>
              {level.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ReasoningSelect;

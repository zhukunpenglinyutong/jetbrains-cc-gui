import { useCallback } from 'react';
import type { TFunction } from 'i18next';
import { extractCommandMessageContent } from '../../utils/messageUtils';
import { stopPropagationHandler } from './historyItemUtils';

export interface HistorySelectionCheckboxProps {
  sessionId: string;
  sessionTitle: string;
  isSelected: boolean;
  t: TFunction;
  onSelectionToggle: (sessionId: string) => void;
}

export const HistorySelectionCheckbox = ({
  sessionId,
  sessionTitle,
  isSelected,
  t,
  onSelectionToggle,
}: HistorySelectionCheckboxProps) => {
  const handleCheckboxChange = useCallback(() => {
    onSelectionToggle(sessionId);
  }, [onSelectionToggle, sessionId]);

  return (
    <label
      className="history-selection-checkbox-wrapper"
      onClick={stopPropagationHandler}
      title={t('history.selectSession')}
    >
      <input
        type="checkbox"
        className="history-selection-checkbox"
        checked={isSelected}
        onChange={handleCheckboxChange}
        onClick={stopPropagationHandler}
        aria-label={t('history.selectSessionWithTitle', { title: extractCommandMessageContent(sessionTitle) })}
      />
    </label>
  );
};

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogManagement } from '../hooks/useDialogManagement';

type DialogManagementValue = ReturnType<typeof useDialogManagement>;

const DialogContext = createContext<DialogManagementValue | null>(null);

/**
 * Hosts useDialogManagement so all dialog-orchestration state (permission /
 * ask-user / plan approval / rewind dialogs) lives in a single provider.
 *
 * Stage 4 of TASK-P1-01.
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const dialogState = useDialogManagement({ t });

  // useDialogManagement already returns a stable object shape per render;
  // wrap in useMemo over its full set of fields to avoid re-creating the
  // context value reference unnecessarily across consumer renders.
  const value = useMemo<DialogManagementValue>(
    () => dialogState,
    // The hook returns ~20 fields; spread into deps so we react to any change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    Object.values(dialogState),
  );

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

export function useDialogs(): DialogManagementValue {
  const ctx = useContext(DialogContext);
  if (ctx === null) {
    throw new Error('useDialogs must be used within a DialogProvider');
  }
  return ctx;
}

export { DialogContext };

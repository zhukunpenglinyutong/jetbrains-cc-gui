import { AppDialogs } from './AppDialogs';
import type { AppDialogsProps } from './AppDialogs';
import type { PermissionMode } from './ChatInputBox/types';

type AppDialogMountsProps = Omit<AppDialogsProps, 'onPlanApprovalModeChange'> & {
  /** Apply the execution mode chosen while approving a Claude plan. */
  onModeSelect: (mode: PermissionMode) => void;
};

/**
 * Dialog mount points extracted from App.tsx: the image-preview portal root
 * plus all top-level dialogs (AppDialogs reads dialog state from DialogContext
 * and UIStateContext directly).
 */
export const AppDialogMounts = ({ onModeSelect, ...dialogsProps }: AppDialogMountsProps) => (
  <>
    <div id="image-preview-root" />
    <AppDialogs
      {...dialogsProps}
      onPlanApprovalModeChange={(mode) => onModeSelect(mode as PermissionMode)}
    />
  </>
);

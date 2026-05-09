import { type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from './ConfirmDialog';
import PermissionDialog from './PermissionDialog';
import AskUserQuestionDialog from './AskUserQuestionDialog';
import PlanApprovalDialog from './PlanApprovalDialog';
import RewindDialog from './RewindDialog';
import RewindSelectDialog, { type RewindableMessage } from './RewindSelectDialog';
import ChangelogDialog from './ChangelogDialog';
import CustomModelDialog from './settings/CustomModelDialog';
import { usePluginModels } from './settings/hooks/usePluginModels';
import { STORAGE_KEYS } from '../types/provider';
import { CHANGELOG_DATA } from '../version/changelog';
import { useDialogs } from '../contexts/DialogContext';
import { useUIState } from '../contexts/UIStateContext';

/**
 * Wrapper that manages plugin-level custom models for the add-model dialog.
 * Uses the shared usePluginModels hook for localStorage persistence.
 */
const AddModelDialogWrapper = ({
  isOpen,
  onClose,
  currentProvider,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentProvider: string;
}) => {
  const storageKey = currentProvider === 'codex'
    ? STORAGE_KEYS.CODEX_CUSTOM_MODELS
    : STORAGE_KEYS.CLAUDE_CUSTOM_MODELS;
  const { models, updateModels } = usePluginModels(storageKey);
  return (
    <CustomModelDialog
      isOpen={isOpen}
      models={models}
      onModelsChange={updateModels}
      onClose={onClose}
      initialAddMode
    />
  );
};

export interface AppDialogsProps {
  /** Session-management dialogs come from useSessionManagement, still passed as props. */
  showNewSessionConfirm: boolean;
  onConfirmNewSession: () => void;
  onCancelNewSession: () => void;
  showInterruptConfirm: boolean;
  onConfirmInterrupt: () => void;
  onCancelInterrupt: () => void;
  /** Rewind selection list is computed in App.tsx from messages, still a prop. */
  rewindableMessages: RewindableMessage[];
  onRewindSelect: ComponentProps<typeof RewindSelectDialog>['onSelect'];
  onRewindSelectCancel: ComponentProps<typeof RewindSelectDialog>['onCancel'];
  onRewindConfirm: ComponentProps<typeof RewindDialog>['onConfirm'];
  onRewindCancel: ComponentProps<typeof RewindDialog>['onCancel'];
  /** Provider id for the add-model dialog (lives in useModelProviderState). */
  currentProvider: string;
}

/**
 * Renders all top-level dialogs.
 * Permission / ask-user / plan / rewind / changelog / add-model state is read
 * from DialogContext and UIStateContext directly to avoid prop drilling 25+
 * fields from App.tsx (stage 4-5 of TASK-P1-01).
 */
export const AppDialogs = ({
  showNewSessionConfirm,
  onConfirmNewSession,
  onCancelNewSession,
  showInterruptConfirm,
  onConfirmInterrupt,
  onCancelInterrupt,
  rewindableMessages,
  onRewindSelect,
  onRewindSelectCancel,
  onRewindConfirm,
  onRewindCancel,
  currentProvider,
}: AppDialogsProps) => {
  const { t } = useTranslation();
  const {
    permissionDialogOpen, currentPermissionRequest,
    handlePermissionApprove, handlePermissionApproveAlways, handlePermissionSkip,
    askUserQuestionDialogOpen, currentAskUserQuestionRequest,
    handleAskUserQuestionSubmit, handleAskUserQuestionCancel,
    planApprovalDialogOpen, currentPlanApprovalRequest,
    handlePlanApprovalApprove, handlePlanApprovalReject,
    rewindSelectDialogOpen, rewindDialogOpen, currentRewindRequest, isRewinding,
  } = useDialogs();
  const {
    showChangelogDialog, closeChangelogDialog,
    addModelDialogOpen, setAddModelDialogOpen,
  } = useUIState();

  return (
    <>
      <ConfirmDialog
        isOpen={showNewSessionConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmNewSession')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={onConfirmNewSession}
        onCancel={onCancelNewSession}
      />
      <ConfirmDialog
        isOpen={showInterruptConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmInterrupt')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={onConfirmInterrupt}
        onCancel={onCancelInterrupt}
      />
      <PermissionDialog
        isOpen={permissionDialogOpen}
        request={currentPermissionRequest}
        onApprove={handlePermissionApprove}
        onSkip={handlePermissionSkip}
        onApproveAlways={handlePermissionApproveAlways}
      />
      <AskUserQuestionDialog
        isOpen={askUserQuestionDialogOpen}
        request={currentAskUserQuestionRequest}
        onSubmit={handleAskUserQuestionSubmit}
        onCancel={handleAskUserQuestionCancel}
      />
      <PlanApprovalDialog
        isOpen={planApprovalDialogOpen}
        request={currentPlanApprovalRequest}
        onApprove={handlePlanApprovalApprove}
        onReject={handlePlanApprovalReject}
      />
      <RewindSelectDialog
        isOpen={rewindSelectDialogOpen}
        rewindableMessages={rewindableMessages}
        onSelect={onRewindSelect}
        onCancel={onRewindSelectCancel}
      />
      <RewindDialog
        isOpen={rewindDialogOpen}
        request={currentRewindRequest}
        isLoading={isRewinding}
        onConfirm={onRewindConfirm}
        onCancel={onRewindCancel}
      />
      <ChangelogDialog
        isOpen={showChangelogDialog}
        onClose={closeChangelogDialog}
        entries={CHANGELOG_DATA}
      />
      <AddModelDialogWrapper
        isOpen={addModelDialogOpen}
        onClose={() => setAddModelDialogOpen(false)}
        currentProvider={currentProvider}
      />
    </>
  );
};

import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../ConfirmDialog';
import type { PetConfirmation } from './types';

interface PetConfirmationDialogProps {
  confirmation: PetConfirmation;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function PetConfirmationDialog({
  confirmation,
  onConfirm,
  onCancel,
}: PetConfirmationDialogProps) {
  const { t } = useTranslation();

  return (
    <ConfirmDialog
      isOpen={confirmation !== null}
      title={confirmation?.kind === 'delete'
        ? t('settings.pet.deleteConfirmTitle')
        : confirmation?.kind === 'uninstall'
          ? t('settings.pet.uninstallConfirmTitle')
          : t('settings.pet.hatchReplaceDraftConfirmTitle')}
      message={confirmation?.kind === 'delete'
        ? t('settings.pet.deleteConfirm', { name: confirmation.name })
        : confirmation?.kind === 'uninstall'
          ? t('settings.pet.uninstallConfirm', { name: confirmation.name })
          : t('settings.pet.hatchReplaceDraftConfirm')}
      confirmText={confirmation?.kind === 'delete'
        ? t('settings.pet.delete')
        : confirmation?.kind === 'uninstall'
          ? t('settings.pet.uninstall')
          : t('settings.pet.hatchReplaceDraftAction')}
      cancelText={t('common.cancel')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

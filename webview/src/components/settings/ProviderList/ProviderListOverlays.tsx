import type { ProviderConfig } from '../../../types/provider';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import {
  EditCcSwitchDialog,
  ConvertConfirmDialog,
  LocalProviderAuthorizeDialog,
  LocalProviderDisableDialog,
  CliLoginAuthorizeDialog,
  CliLoginDisableDialog,
  HelpDialog,
} from './ProviderListDialogs';

interface ProviderListOverlaysProps {
  editingCcSwitchProvider: ProviderConfig | null;
  convertingProvider: ProviderConfig | null;
  showLocalProviderConfirm: boolean;
  showLocalProviderDisableConfirm: boolean;
  showCliLoginConfirm: boolean;
  showCliLoginDisableConfirm: boolean;
  helpKind: 'local' | 'cli' | null;
  setEditingCcSwitchProvider: (provider: ProviderConfig | null) => void;
  setConvertingProvider: (provider: ProviderConfig | null) => void;
  setShowLocalProviderConfirm: (show: boolean) => void;
  setShowLocalProviderDisableConfirm: (show: boolean) => void;
  setShowCliLoginConfirm: (show: boolean) => void;
  setShowCliLoginDisableConfirm: (show: boolean) => void;
  setCliLoginAccountEmail: (email: string | null) => void;
  setHelpKind: (kind: 'local' | 'cli' | null) => void;
  onEdit: (provider: ProviderConfig) => void;
  onSwitch: (id: string) => void;
  onConvertConfirm: () => void;
}

/** All modal warning/confirm/help dialogs rendered above the provider list. */
export default function ProviderListOverlays({
  editingCcSwitchProvider,
  convertingProvider,
  showLocalProviderConfirm,
  showLocalProviderDisableConfirm,
  showCliLoginConfirm,
  showCliLoginDisableConfirm,
  helpKind,
  setEditingCcSwitchProvider,
  setConvertingProvider,
  setShowLocalProviderConfirm,
  setShowLocalProviderDisableConfirm,
  setShowCliLoginConfirm,
  setShowCliLoginDisableConfirm,
  setCliLoginAccountEmail,
  setHelpKind,
  onEdit,
  onSwitch,
  onConvertConfirm,
}: ProviderListOverlaysProps) {
  return (
    <>
      {/* Edit warning dialog */}
      {editingCcSwitchProvider && (
        <EditCcSwitchDialog
          onCancel={() => setEditingCcSwitchProvider(null)}
          onContinue={() => {
            const p = editingCcSwitchProvider;
            setEditingCcSwitchProvider(null);
            onEdit(p);
          }}
          onConvert={() => {
            setConvertingProvider(editingCcSwitchProvider);
            // Keep editingCcSwitchProvider set to handle after conversion
          }}
        />
      )}

      {/* Conversion confirmation dialog */}
      {convertingProvider && (
        <ConvertConfirmDialog
          providerName={convertingProvider.name}
          onCancel={() => {
            setConvertingProvider(null);
            // If triggered from editing, canceling conversion also cancels editing
            if (editingCcSwitchProvider) {
              setEditingCcSwitchProvider(null);
            }
          }}
          onConfirm={onConvertConfirm}
        />
      )}

      {showLocalProviderConfirm && (
        <LocalProviderAuthorizeDialog
          onCancel={() => setShowLocalProviderConfirm(false)}
          onConfirm={() => {
            setShowLocalProviderConfirm(false);
            onSwitch(SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS);
          }}
        />
      )}

      {showLocalProviderDisableConfirm && (
        <LocalProviderDisableDialog
          onCancel={() => setShowLocalProviderDisableConfirm(false)}
          onConfirm={() => {
            setShowLocalProviderDisableConfirm(false);
            onSwitch(SPECIAL_PROVIDER_IDS.DISABLED);
          }}
        />
      )}

      {showCliLoginConfirm && (
        <CliLoginAuthorizeDialog
          onCancel={() => setShowCliLoginConfirm(false)}
          onConfirm={() => {
            setShowCliLoginConfirm(false);
            onSwitch(SPECIAL_PROVIDER_IDS.CLI_LOGIN);
          }}
        />
      )}

      {showCliLoginDisableConfirm && (
        <CliLoginDisableDialog
          onCancel={() => setShowCliLoginDisableConfirm(false)}
          onConfirm={() => {
            setShowCliLoginDisableConfirm(false);
            setCliLoginAccountEmail(null);
            onSwitch(SPECIAL_PROVIDER_IDS.DISABLED);
          }}
        />
      )}

      {helpKind && (
        <HelpDialog
          kind={helpKind}
          onClose={() => setHelpKind(null)}
        />
      )}
    </>
  );
}

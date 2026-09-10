export type PendingPetOperation = {
  operation: 'install' | 'uninstall' | 'delete' | 'alias';
  target: string;
};
export type HatchPetAction = 'install' | 'create' | 'repair';
export type PetConfirmation =
  | { kind: 'delete'; petId: string; name: string }
  | { kind: 'uninstall'; slug: string; name: string }
  | { kind: 'replace-draft'; action: HatchPetAction }
  | null;
export type PetSettingsTab = 'basic' | 'actions' | 'bubble' | 'local' | 'petdex';

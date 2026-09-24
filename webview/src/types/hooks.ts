export type HookProvider = 'codex' | 'claude' | 'codemoss';
export type HookScope = 'GLOBAL' | 'GLOBAL_LOCAL' | 'PROJECT' | 'PROJECT_LOCAL';

export interface HookItem {
  sourceId: string;
  provider: HookProvider;
  scope: HookScope;
  event: string;
  matcher?: string;
  command: string;
  enabled: boolean;
  toggleSupported: boolean;
  managedToggleSupported?: boolean;
  toggleMode?: 'ccgui-managed' | 'native';
  managedKey?: string;
  toggleReason?: string;
  editSupported?: boolean;
  rawLocation: string;
  relativePath?: string;
  schemaVersion: number;
  format: string;
  revision: string;
  lastModified?: number;
  validationIssues: string[];
  rawPreview?: string;
  extensions: Record<string, unknown>;
}

export interface HookSource {
  provider: HookProvider;
  scope: HookScope;
  location: string;
  format: string;
  exists: boolean;
  readOnly: boolean;
  revision: string;
  lastModified?: number;
  validationIssues: string[];
}

export type HookEditorTarget = HookItem | HookSource;

export interface HookCapability {
  provider: HookProvider;
  format: string;
  editSupported: boolean;
  toggleSupported: boolean;
  managedToggleSupported?: boolean;
  toggleMode?: 'ccgui-managed' | 'native' | 'none';
  reasonCode: string;
  versionStatus: 'UNVERIFIED' | 'VERIFIED';
}

export interface HookCatalog {
  schemaVersion: number;
  items: HookItem[];
  sources: HookSource[];
  capabilities: HookCapability[];
  readOnly: boolean;
}

export interface HookSourcePayload {
  success: boolean;
  location?: string;
  revision?: string;
  content?: string;
  backupPath?: string;
  backupDirectory?: string;
  lastModified?: number;
  errorCode?: string;
}

export type HookMutationResult = HookSourcePayload;

export interface HookToggleResult {
  success: boolean;
  requestId?: string;
  location?: string;
  sourceId?: string;
  enabled?: boolean;
  revision?: string;
  toggleMode?: 'ccgui-managed' | 'native';
  errorCode?: string;
}

export const EMPTY_HOOK_CATALOG: HookCatalog = {
  schemaVersion: 1,
  items: [],
  sources: [],
  capabilities: [],
  readOnly: true,
};

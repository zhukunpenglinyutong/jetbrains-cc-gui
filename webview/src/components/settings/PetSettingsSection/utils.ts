const PET_ERROR_TRANSLATIONS: Record<string, string> = {
  PETDEX_CONNECT_TIMEOUT: 'settings.pet.connectTimeoutError',
  PETDEX_REQUEST_TIMEOUT: 'settings.pet.requestTimeoutError',
  PETDEX_NETWORK_ERROR: 'settings.pet.networkError',
  PET_NOT_FOUND: 'settings.pet.petNotFound',
  PET_NOT_INSTALLED: 'settings.pet.petNotFound',
  PET_ALREADY_INSTALLED: 'settings.pet.alreadyInstalled',
  PETDEX_RESPONSE_TOO_LARGE: 'settings.pet.resourceTooLarge',
  INVALID_PET_JSON: 'settings.pet.invalidPackage',
  INVALID_PET_SLUG: 'settings.pet.invalidPackage',
  PET_PATH_OUTSIDE_ROOT: 'settings.pet.invalidPackage',
  PET_NOT_MANAGED_BY_PLUGIN: 'settings.pet.invalidPackage',
  PET_ALIAS_TOO_LONG: 'settings.pet.aliasTooLong',
  INVALID_PET_ALIAS: 'settings.pet.invalidAlias',
  PET_ALIAS_UPDATE_FAILED: 'settings.pet.aliasUpdateFailed',
  INVALID_LOCAL_PET_ID: 'settings.pet.invalidPackage',
  LOCAL_PET_NOT_FOUND: 'settings.pet.petNotFound',
  LOCAL_PET_OPERATION_FAILED: 'settings.pet.localPetOperationFailed',
  PET_DIRECTORY_UNAVAILABLE: 'settings.pet.petDirectoryUnavailable',
  INVALID_HATCH_PET_ACTION: 'settings.pet.hatchCommandFailed',
  HATCH_PET_SKILL_NOT_READY: 'settings.pet.hatchSkillNotReady',
  HATCH_PET_INPUT_REQUIRED: 'settings.pet.hatchInputRequired',
  HATCH_PET_REQUIRES_CODEX: 'settings.pet.hatchRequiresCodex',
  HATCH_PET_COMMAND_INSERT_FAILED: 'settings.pet.hatchCommandFailed',
  PETDEX_URL_NOT_ALLOWED: 'settings.pet.invalidPackage',
  PETDEX_REDIRECT_WITHOUT_LOCATION: 'settings.pet.networkError',
  PETDEX_TOO_MANY_REDIRECTS: 'settings.pet.networkError',
  INVALID_PETDEX_MANIFEST: 'settings.pet.invalidPackage',
  EMPTY_PETDEX_MANIFEST: 'settings.pet.invalidPackage',
  INVALID_PETDEX_SPRITESHEET: 'settings.pet.invalidPackage',
  UNDECODABLE_PETDEX_SPRITESHEET: 'settings.pet.invalidPackage',
  UNSUPPORTED_PETDEX_IMAGE: 'settings.pet.invalidPackage',
  PETDEX_PREVIEW_ENCODING_FAILED: 'settings.pet.invalidPackage',
};

export function petErrorDescriptor(error: string): { key: string; params?: Record<string, string> } {
  const translationKey = PET_ERROR_TRANSLATIONS[error];
  if (translationKey) return { key: translationKey };
  if (error.startsWith('PETDEX_HTTP_')) {
    return { key: 'settings.pet.httpError', params: { status: error.slice('PETDEX_HTTP_'.length) } };
  }
  return { key: 'settings.pet.unknownError', params: { code: error } };
}

export function normalizeAliasDraft(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
// Number('abc') is NaN — fall back to the previous config value when the
// input can't be parsed. Empty string stays 0 so the field remains editable.
export function parseNumericInput(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const MAX_CATALOG_QUERY_LENGTH = 100;

export function normalizeCatalogQuery(value: string): string {
  return value.trim().toLowerCase().slice(0, MAX_CATALOG_QUERY_LENGTH);
}

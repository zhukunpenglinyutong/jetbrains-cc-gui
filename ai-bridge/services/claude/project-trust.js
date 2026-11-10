import { normalizePathForComparison, sanitizePath } from '../../utils/path-utils.js';

const TRUSTED_SETTING_SOURCES = Object.freeze(['user', 'project', 'local']);
const UNTRUSTED_SETTING_SOURCES = Object.freeze(['user']);
const NO_CWD_SENTINELS = new Set(['undefined', 'null']);

export function settingSourcesFor(projectTrusted) {
  return projectTrusted === true ? [...TRUSTED_SETTING_SOURCES] : [...UNTRUSTED_SETTING_SOURCES];
}

/**
 * Whether project settings may load in the directory the bridge actually runs in.
 *
 * Java decides `projectTrusted` for the cwd it sends, so the flag covers that directory only.
 * When the bridge ends up somewhere else (the cwd was blank, or Node could not use it and
 * selectWorkingDirectory fell back to an environment project path, its process cwd or the
 * home directory), that directory was never checked, and it stays untrusted.
 *
 * @param {unknown} projectTrusted - The flag from the request; only `true` trusts.
 * @param {unknown} requestedCwd - The cwd Java sent and checked.
 * @param {string|null} workingDirectory - What selectWorkingDirectory returned for it.
 * @returns {boolean}
 */
export function projectTrustFor(projectTrusted, requestedCwd, workingDirectory) {
  if (projectTrusted !== true || typeof requestedCwd !== 'string' || !workingDirectory) {
    return false;
  }
  if (NO_CWD_SENTINELS.has(requestedCwd.trim())) {
    return false;
  }
  const requested = sanitizePath(requestedCwd);
  return !!requested && normalizePathForComparison(requested) === normalizePathForComparison(workingDirectory);
}

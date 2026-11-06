const TRUSTED_SETTING_SOURCES = Object.freeze(['user', 'project', 'local']);
const UNTRUSTED_SETTING_SOURCES = Object.freeze(['user']);

export function settingSourcesFor(projectTrusted) {
  return projectTrusted === true ? [...TRUSTED_SETTING_SOURCES] : [...UNTRUSTED_SETTING_SOURCES];
}

// Ultracode is a native Claude Code workflow setting, independent of effort.
// The independent on/off toggle was introduced in Claude Code 2.1.284.
export const MIN_ULTRACODE_CLI_VERSION = '2.1.284';

export function withUltracodeSetting(settings, ultracode) {
  return {
    ...settings,
    ...(typeof ultracode === 'boolean' ? { ultracode } : {}),
  };
}

export function supportsIndependentUltracode(version) {
  const match = typeof version === 'string' && version.match(/^(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  const minimum = MIN_ULTRACODE_CLI_VERSION.split('.').map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

/** Validate the running CLI, including user-configured executable overrides. */
export async function assertUltracodeSupported(query, options = {}) {
  if (typeof query?.applyFlagSettings !== 'function' || typeof query?.initializationResult !== 'function' || typeof query?.getSettings !== 'function') {
    throw new Error(`Claude Ultracode requires an updated Claude Agent SDK and Claude Code ${MIN_ULTRACODE_CLI_VERSION} or later. Update Claude in Settings > Dependencies.`);
  }
  const initialization = await query.initializationResult();
  if (!supportsIndependentUltracode(initialization?.claude_code_version)) {
    throw new Error(`Claude Ultracode requires Claude Code ${MIN_ULTRACODE_CLI_VERSION} or later; the running CLI reports ${initialization?.claude_code_version || 'an unknown version'}. Update Claude in Settings > Dependencies or your configured CLI executable.`);
  }
  if (options.settings?.disableWorkflows === true || /^(1|true)$/i.test(options.env?.CLAUDE_CODE_DISABLE_WORKFLOWS || '')) {
    throw new Error('Claude Ultracode is unavailable because native dynamic workflows are disabled.');
  }
  // Effort metadata is not an Ultracode capability. The native applied setting
  // checked below determines whether this model/session supports workflows.
}

export async function applyNativeFlagSettings(query, settings) {
  await query.applyFlagSettings(settings);
  if (settings.ultracode === true) {
    // Headless Claude accepts requested settings even when model/policy gates
    // prevent their application. Its settings control is the authoritative
    // confirmation. Never log or forward the remaining settings response.
    const applied = (await query.getSettings())?.applied;
    if (applied?.ultracode !== true) {
      throw new Error(applied?.ultracodeAvailable === false
        ? 'Claude Ultracode is unavailable for this session: native dynamic workflows are disabled or the model does not support them.'
        : 'The running Claude SDK could not confirm native Ultracode is enabled. Update Claude in Settings > Dependencies.');
    }
  }
}

/** Validate before enqueuing input, so an unsupported CLI never starts a paid turn. */
export async function createUltracodeQuery(queryFn, inputStream, userMessage, options) {
  const query = queryFn({ prompt: inputStream, options });
  try {
    await assertUltracodeSupported(query, options);
    await applyNativeFlagSettings(query, { ultracode: true });
    inputStream.enqueue(userMessage);
    inputStream.done();
    return query;
  } catch (error) {
    inputStream.done();
    await query.close?.();
    throw error;
  }
}

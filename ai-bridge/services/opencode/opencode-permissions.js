/**
 * opencode permission mapping helpers.
 *
 * opencode emits permission IDs such as "read", "edit", and "bash".
 * The JetBrains UI expects Claude-style tool names and input fields. Keep the
 * translation small and explicit so mode behavior stays auditable.
 */

const SAFE_READ_PERMISSIONS = new Set([
  'read',
  'grep',
  'glob',
  'lsp',
  'todowrite',
  'plan_enter',
]);

const EDIT_PERMISSIONS = new Set([
  'edit',
]);

const MODE_ALLOWING_EDITS = new Set([
  'acceptEdits',
  'autoEdit',
]);

function normalizePermission(permission) {
  return typeof permission === 'string' ? permission.trim().toLowerCase() : '';
}

function normalizeMode(mode) {
  return typeof mode === 'string' && mode.trim() ? mode.trim() : 'default';
}

export function isSafeOpenCodePermission(permission) {
  return SAFE_READ_PERMISSIONS.has(normalizePermission(permission));
}

export function isEditOpenCodePermission(permission) {
  return EDIT_PERMISSIONS.has(normalizePermission(permission));
}

export function shouldAutoAllowOpenCodePermission(permission, permissionMode) {
  const normalizedMode = normalizeMode(permissionMode);
  if (normalizedMode === 'bypassPermissions') {
    return true;
  }
  if (isSafeOpenCodePermission(permission)) {
    return true;
  }
  return MODE_ALLOWING_EDITS.has(normalizedMode) && isEditOpenCodePermission(permission);
}

export function shouldAutoRejectOpenCodePermission(permission, permissionMode) {
  return normalizeMode(permissionMode) === 'plan' && !isSafeOpenCodePermission(permission);
}

export function mapOpenCodePermissionToToolName(permission) {
  switch (normalizePermission(permission)) {
    case 'read':
      return 'Read';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'lsp':
      return 'LSP';
    case 'edit':
      return 'Edit';
    case 'bash':
      return 'Bash';
    case 'task':
      return 'Agent';
    case 'webfetch':
      return 'WebFetch';
    case 'websearch':
      return 'WebSearch';
    case 'external_directory':
      return 'ExternalDirectory';
    case 'todowrite':
      return 'TodoWrite';
    default:
      return permission && String(permission).trim() ? String(permission).trim() : 'opencode';
  }
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

export function buildOpenCodePermissionDialogRequest(permissionRequest, cwd = '') {
  const request = permissionRequest && typeof permissionRequest === 'object'
    ? permissionRequest
    : {};
  const permission = firstString(request.permission, request.type, 'opencode');
  const normalizedPermission = normalizePermission(permission);
  const metadata = request.metadata && typeof request.metadata === 'object'
    ? request.metadata
    : {};
  const patterns = arrayOfStrings(request.patterns);
  const always = arrayOfStrings(request.always);

  const inputs = {
    cwd,
    provider: 'opencode',
    requestId: firstString(request.id, request.requestID, request.permissionID),
    permission,
    patterns,
    always,
    metadata,
  };

  if (normalizedPermission === 'edit') {
    const filepath = firstString(metadata.filepath, metadata.filePath, metadata.path, patterns[0]);
    if (filepath) {
      inputs.file_path = filepath;
      inputs.path = filepath;
    }
    if (typeof metadata.diff === 'string' && metadata.diff) {
      inputs.content = metadata.diff;
      inputs.diff = metadata.diff;
    }
  } else if (normalizedPermission === 'bash') {
    const command = firstString(metadata.command, metadata.cmd, patterns.join('\n'));
    if (command) {
      inputs.command = command;
    }
  } else if (normalizedPermission === 'read') {
    const path = firstString(metadata.filepath, metadata.filePath, metadata.path, patterns[0]);
    if (path) {
      inputs.file_path = path;
      inputs.path = path;
    }
  } else if (normalizedPermission === 'grep' || normalizedPermission === 'glob') {
    const pattern = firstString(metadata.pattern, patterns[0]);
    if (pattern) {
      inputs.pattern = pattern;
      inputs.command = pattern;
    }
    const path = firstString(metadata.path, metadata.filepath, metadata.filePath);
    if (path) {
      inputs.path = path;
    }
  } else if (normalizedPermission === 'external_directory') {
    const path = firstString(metadata.path, metadata.directory, patterns[0]);
    if (path) {
      inputs.path = path;
      inputs.command = path;
    }
  } else if (patterns.length > 0) {
    inputs.command = patterns.join('\n');
  }

  return {
    toolName: mapOpenCodePermissionToToolName(permission),
    inputs,
  };
}

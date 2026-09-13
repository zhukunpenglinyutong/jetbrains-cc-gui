/**
 * DSH agent-preset → headless patch overlay conversion.
 *
 * The DeepSeek Harness web app offers four agent presets (标准/极简/PTC/创造)
 * that are composed per-session by the `dsh-agent-presets` plugin. The CC GUI
 * dsh integration runs `dsh --profile headless`, whose base composition ships
 * the full standard toolset and has no `agent-presets` row — so the presets
 * are NOT available to it out of the box.
 *
 * This module emulates preset mounting by converting a preset's
 * `agent.cordis.yml` composition into a `--patch` overlay that the headless
 * profile can apply:
 *
 * - Rows whose id already exists in the headless base tree are emitted as
 *   plain patch entries (override the base row, last-wins).
 * - Rows with new ids are wrapped in an `insert:` block (the loader drops
 *   plain entries with unknown ids — `--patch` only patches known rows).
 * - The `minimal` preset additionally emits `disabled: true` overrides for the
 *   base capability rows it is defined to remove, so the agent really ends up
 *   with only its persistent shell + str-replace-editor.
 *
 * The base-row id set is discovered once per process via
 * `dsh --profile headless --dump-config` and cached, so per-message spawns
 * stay cheap after the first run.
 */

import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'url';
import { enrichPathWithBinDirs, commonCliBinDirs, resolveCliSpawn } from '../../utils/cli-path.js';

/**
 * The shipped DSH agent presets plus user-installed ones curated by the CC
 * GUI (they get localized labels/descriptions on the frontend). Ids =
 * directory names under the dsh installation (config/agent-presets/<id>) or
 * under the user preset root (<dshHome>/.agent-presets/<id>, e.g. the
 * dsh-routing-suite router-standard preset).
 *
 * Any OTHER preset the user drops into <dshHome>/.agent-presets/ is picked
 * up dynamically via {@link discoverUserPresetIds} — no code change needed
 * (see {@link getKnownDshPresetIds} / {@link isKnownDshPresetId}).
 */
export const DSH_PRESET_IDS = ['standard', 'code', 'minimal', 'cordis', 'router-standard'];

/**
 * Discover user-installed preset ids under <dshHome>/.agent-presets/<id>/.
 *
 * dshHome is `${DSH_HOME:-$HOME/.dsh}` — the same root the
 * `dsh-agent-presets` plugin scans, so anything the DSH web app can select
 * (e.g. the dsh-routing-suite router-standard/router-flash presets) is found
 * here too. A directory counts as a preset when it ships an
 * `agent.cordis.yml` composition. Missing/unreadable roots yield an empty
 * list. Scanned on every call so presets installed while the IDE is running
 * take effect on the next send.
 *
 * @returns {string[]} sorted preset ids
 */
export function discoverUserPresetIds() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const root = join(dshHome, '.agent-presets');
  const ids = [];
  try {
    for (const dirent of readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      try {
        if (existsSync(join(root, dirent.name, 'agent.cordis.yml'))) {
          ids.push(dirent.name);
        }
      } catch {
        // Unreadable subdir — skip.
      }
    }
  } catch {
    // Root missing or unreadable — no user presets.
  }
  return ids.sort();
}
/**
 * All preset ids the CC GUI accepts: the shipped/curated set plus whatever
 * the user has installed under <dshHome>/.agent-presets/ (deduplicated).
 *
 * @returns {string[]}
 */
export function getKnownDshPresetIds() {
  return [...new Set([...DSH_PRESET_IDS, ...discoverUserPresetIds()])];
}

/**
 * Whether a preset id is known to the CC GUI (shipped, curated, or
 * user-installed under <dshHome>/.agent-presets/).
 *
 * @param {string} presetId
 * @returns {boolean}
 */
export function isKnownDshPresetId(presetId) {
  return typeof presetId === 'string' && presetId !== '' && getKnownDshPresetIds().includes(presetId);
}

/**
 * Headless base rows that the `minimal` preset is defined to NOT have (the
 * standard toolset). The preset file only adds its two tools; emulating
 * "minimal" on top of the full headless base requires disabling these rows.
 * Curated from the headless bundle composition; unknown ids are skipped.
 */
const MINIMAL_DISABLED_BASE_IDS = [
  'agent-instructions',
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-skill',
  'skill',
  'skill-filesystem',
  'skill-badge',
  'tool-goal',
  'command-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-report',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'tool-todo',
  'tool-web',
];

/** Cached headless base row ids (Set). */
let cachedBaseIds = null;

function logDebug(...args) {
  console.error('[DEBUG][Dsh][Preset]', ...args);
}

/**
 * Parse a preset's `agent.cordis.yml` into top-level entry blocks.
 *
 * A block starts at a column-0 `- ` line and runs until the next column-0
 * `- ` line. Pure column-0 comment lines are skipped. Returns
 * `[{ id: string|null, block: string[] }]` — `id` is the entry's 2-space
 * indented `id:` value, or null when the block has none.
 *
 * @param {string} text
 * @returns {Array<{ id: string|null, block: string[] }>}
 */
export function parsePresetEntries(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let current = null;
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (current) entries.push(current);
      current = { id: null, block: [line] };
      continue;
    }
    if (current) {
      current.block.push(line);
      continue;
    }
    // Lines before the first entry (file header comments) are dropped.
  }
  if (current) entries.push(current);
  for (const entry of entries) {
    for (const line of entry.block) {
      // `- id: persona` (id inline with the list dash) or `  id: persona`.
      const inline = /^- id: (\S+)/.exec(line);
      const own = /^ {2}id: (\S+)/.exec(line);
      if (inline || own) {
        entry.id = (inline || own)[1];
        break;
      }
    }
  }
  return entries;
}

/**
 * Extract the persona text from a preset `persona` entry block.
 *
 * The presets declare their persona as
 * `- id: persona / name: '@deepseek-ai/dsh-persona' / config: { text: <scalar> }`.
 * The headless base has no `persona` row — it owns `system-prompt` with
 * `config.persona` — and inserting a second persona plugin row makes the
 * system-prompt registry throw (`deployment:persona already registered`), so
 * the text is remapped onto the `system-prompt` row instead.
 *
 * @param {string[]} block
 * @returns {string|null} the persona text, or null when the block has none
 */
export function extractPersonaText(block) {
  const textIdx = block.findIndex((line) => /^ {4}text: /.test(line));
  if (textIdx < 0) return null;
  const header = block[textIdx];
  const inline = /^ {4}text: (.+)$/.exec(header);
  if (inline && !/^(>-|>\||\|-|\|)/.test(inline[1])) {
    return inline[1].trim();
  }
  // Multi-line scalar: content lines follow at ≥6 spaces; the style tag
  // (`>-` folded / `|-` literal) is preserved.
  const style = /^ {4}text: (\|[-+]?|>[-+]?)/.exec(header);
  const styleTag = style ? style[1] : '>-';
  const content = [];
  for (let i = textIdx + 1; i < block.length; i++) {
    const line = block[i];
    if (/^ {2}\S/.test(line) && !/^ {4}\S/.test(line)) break; // next key at 2-space indent
    if (line.trim() === '' || /^ {6}/.test(line)) {
      content.push(line.replace(/^ {6}/, ''));
    } else {
      break;
    }
  }
  if (content.length === 0) return null;
  return `${styleTag}\n${content.map((l) => (l === '' ? '' : `      ${l}`)).join('\n')}`;
}

/**
 * Preset-specific conversion tweaks for the headless base.
 *
 * - `minimal`: its `filesystem` group embeds a `str-replace-editor` entry, but
 *   the headless base already registers the `str_replace_editor` tool — a
 *   second registration throws. The base copy is kept (it is the same tool).
 * - `cordis`: `tool-cordis` waits for host services (`dynamicCordisRunner`,
 *   `cordisInspect`) that the headless host composition does not provide, so
 *   the row can never activate and would fail the whole boot. It is dropped;
 *   the rest of the preset (persona, skills, standard toolset) still applies.
 *
 * @param {string} presetId
 * @returns {{ dropEntryIds?: string[], stripNestedIds?: string[] }}
 */
function presetOverlayOptions(presetId) {
  if (presetId === 'minimal') return { stripNestedIds: ['str-replace-editor'] };
  if (presetId === 'cordis') return { dropEntryIds: ['tool-cordis'] };
  return {};
}

/**
 * Remove nested entries (4-space indented `- id:` lines inside a group's
 * `config:`) whose id is listed, together with their sub-lines.
 *
 * @param {string[]} block
 * @param {Set<string>} stripIds
 * @returns {string[]}
 */
function stripNestedEntryLines(block, stripIds) {
  const out = [];
  let skipping = false;
  for (const line of block) {
    const nested = /^ {4}- (?:id: )?(\S+)/.exec(line);
    if (nested && stripIds.has(nested[1])) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // Nested entry body lines are indented ≥6 spaces; a 4-space `- ` (next
      // sibling) or a 2-space key (group keys like `isolate:`) ends the skip.
      if (/^ {4}- /.test(line) || /^ {2}\S/.test(line)) skipping = false;
      else continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Build the patch overlay text for a preset against a known base id set.
 *
 * Conversion rules (headless base owns the full standard toolset at root):
 * - `persona` → override the base `system-prompt` row's persona text (the
 *   preset persona plugin cannot be inserted — see {@link extractPersonaText}).
 * - Rows whose id already exists in the base tree → plain patch entries
 *   (override, last-wins).
 * - Rows with new ids → wrapped in an `insert:` block (the loader drops plain
 *   entries with unknown ids).
 * - `minimal` → `disabled: true` overrides for the base capability rows it is
 *   defined to remove.
 * - `cordis` → the `tool-cordis` row is dropped (host services missing).
 *
 * @param {object} options
 * @param {string} options.presetId - a known preset id (see {@link isKnownDshPresetId})
 * @param {string} options.presetText - raw agent.cordis.yml content
 * @param {Set<string>} options.baseIds - headless base row ids
 * @param {string} [options.presetDir] - absolute path of the preset dir; when
 *   set, `baseUrl`-relative config values (the cordis preset's skill roots)
 *   are rewritten to absolute paths into that directory.
 * @returns {string} YAML entries to append to a `--patch` overlay file
 */
export function buildPresetOverlay({ presetId, presetText, baseIds, presetDir = '' }) {
  const { dropEntryIds = [], stripNestedIds = [] } = presetOverlayOptions(presetId);
  const dropIds = new Set(dropEntryIds);
  const stripIds = new Set(stripNestedIds);
  // pathToFileURL keeps the URL well-formed on both platforms — the previous
  // `file:///${dir}` template produced `file:////tmp/...` on POSIX (pathname
  // `//tmp/...`), which breaks ESM resolution of the preset's local plugins.
  const presetDirUrl = presetDir ? pathToFileURL(presetDir.replace(/[\\/]+$/, '') + '/').href : '';
  const entries = parsePresetEntries(presetText);
  const overrides = [];
  const inserts = [];
  for (const entry of entries) {
    if (entry.id !== null && dropIds.has(entry.id)) {
      continue;
    }
    let block = entry.block;
    if (stripIds.size > 0) {
      block = stripNestedEntryLines(block, stripIds);
    }
    if (presetDirUrl) {
      block = block.map((line) => {
        // Relative plugin rows (`name: ./router-bootstrap.mjs`) in user
        // presets resolve against the headless PROFILE dir, not the patch
        // file — the loader would fail to find them. Rewrite to absolute
        // file:// URLs into the preset dir (the router-standard preset ships
        // its local plugin files next to the composition; the plugin's own
        // ESM imports then resolve relative to that URL).
        const relName = /^(\s*)name: (\.\/\S+)\s*$/.exec(line);
        if (relName) {
          return `${relName[1]}name: ${presetDirUrl}${relName[2].slice(2)}`;
        }
        // `- !!js "... fileURLToPath(new URL('skills/', baseUrl))"` — emit the
        // resolved path directly instead of a JS expression (a URL string
        // inside the quoted expression would break the YAML scalar).
        if (line.includes('skills/') && line.includes('baseUrl')) {
          const indent = /^\s*/.exec(line)[0];
          return `${indent}- ${presetDir.replace(/\\/g, '/')}/skills`;
        }
        return line.replace(/\bbaseUrl\b/g, JSON.stringify(presetDirUrl));
      });
    }
    if (entry.id === 'persona') {
      const personaText = extractPersonaText(block);
      if (personaText) {
        overrides.push(
          `- id: system-prompt\n  config:\n    persona: ${personaText}`
        );
      }
      continue;
    }
    if (entry.id !== null && baseIds.has(entry.id)) {
      overrides.push(block.join('\n'));
    } else {
      inserts.push(block);
    }
  }

  const parts = [];
  if (overrides.length > 0) {
    parts.push(overrides.join('\n'));
  }
  if (inserts.length > 0) {
    const nested = inserts.flatMap((block) => block.map((line) => `    ${line}`));
    parts.push(`- insert:\n${nested.join('\n')}`);
  }

  if (presetId === 'minimal') {
    const disabled = MINIMAL_DISABLED_BASE_IDS.filter((id) => baseIds.has(id));
    if (disabled.length > 0) {
      parts.push(disabled.map((id) => `- id: ${id}\n  disabled: true`).join('\n'));
    }
  }

  return parts.join('\n');
}

/**
 * Locate the preset directory in the dsh installation or the user preset root.
 *
 * The npm global install layout is `<prefix>/node_modules/@deepseek-ai/dsh/`
 * with `config/agent-presets/<id>/`. User-installed presets (e.g. the
 * dsh-routing-suite router-standard preset) live under
 * `<dshHome>/.agent-presets/<id>/` where dshHome is `${DSH_HOME:-$HOME/.dsh}`
 * — the same root the `dsh-agent-presets` plugin scans, so anything the DSH
 * web app can select is found here too. From the resolved spawn command:
 * - Windows `.cmd` shim: `resolveCliSpawn` launches it via `cmd.exe`, so the
 *   preset directory is located from the bin path candidates below instead.
 * - POSIX: try `dirname(dirname(bin))` (bin under `<pkgRoot>/bin/`) and the
 *   npm prefix layout `<prefix>/lib/node_modules/@deepseek-ai/dsh`.
 *
 * @param {string} presetId
 * @param {{ bin: string, args: string[], shell: boolean }} spawnCmd
 * @returns {string|null} absolute path of the preset directory
 */
export function resolveDshPresetDir(presetId, spawnCmd) {
  if (!isKnownDshPresetId(presetId)) return null;
  const candidates = [];
  const scriptPath = spawnCmd && Array.isArray(spawnCmd.args) && spawnCmd.args[0]
    ? spawnCmd.args[0]
    : null;
  if (scriptPath && /[\\/]lib[\\/][^\\/]+\.js$/.test(scriptPath)) {
    // <pkgRoot>/lib/<file>.js → pkgRoot = dirname(dirname(script))
    candidates.push(join(dirname(dirname(scriptPath)), 'config', 'agent-presets', presetId));
  }
  const bin = spawnCmd ? spawnCmd.bin : '';
  if (bin) {
    candidates.push(join(dirname(dirname(bin)), 'config', 'agent-presets', presetId));
    // npm global layout on POSIX: <prefix>/lib/node_modules/@deepseek-ai/dsh
    candidates.push(join(dirname(dirname(bin)), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', presetId));
  }
  // User preset root: <dshHome>/.agent-presets/<id> (shipped presets shadow
  // same-named home directories, matching dsh-agent-presets' precedence).
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  candidates.push(join(dshHome, '.agent-presets', presetId));
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, 'agent.cordis.yml'))) return candidate;
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Discover the headless base row ids (cached per process).
 *
 * @param {{ bin: string, args: string[], shell: boolean }} spawnCmd
 * @param {{ refresh?: boolean }} [options]
 * @returns {Set<string>|null} base row ids, or null when the dump failed
 */
export function getHeadlessBaseIds(spawnCmd, options = {}) {
  if (cachedBaseIds && !options.refresh) return cachedBaseIds;
  const bin = spawnCmd ? spawnCmd.bin : '';
  if (!bin) return null;
  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, commonCliBinDirs(home));
  try {
    // Route through resolveCliSpawn so Windows `.cmd`/`.bat` shims launch via
    // cmd.exe (CVE-2024-27980) — a raw spawn of a shim fails with EINVAL and
    // would silently drop the preset overlay.
    const invocation = resolveCliSpawn(bin, [...(spawnCmd.args || []), '--profile', 'headless', '--dump-config'], {
      env,
      windowsHide: true,
    });
    const result = spawnSync(invocation.file, invocation.args, {
      ...invocation.options,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      logDebug('dump-config failed:', result.error?.message || `status ${result.status}`);
      return null;
    }
    const ids = new Set();
    const output = String(result.stdout || '');
    for (const line of output.split(/\r?\n/)) {
      const m = /^\s*- id: (\S+)/.exec(line);
      if (m) ids.add(m[1]);
    }
    cachedBaseIds = ids;
    return ids;
  } catch (error) {
    logDebug('dump-config threw:', error?.message || error);
    return null;
  }
}

/**
 * Resolve a preset's agent.cordis.yml path (null when unavailable).
 *
 * @param {string} presetId
 * @param {{ bin: string, args: string[], shell: boolean }} spawnCmd
 * @returns {string|null}
 */
export function resolveDshPresetFile(presetId, spawnCmd) {
  const dir = resolveDshPresetDir(presetId, spawnCmd);
  if (!dir) return null;
  return join(dir, 'agent.cordis.yml');
}

/**
 * Read a preset's composition text (null when unavailable).
 *
 * @param {string} presetId
 * @param {{ bin: string, args: string[], shell: boolean }} spawnCmd
 * @returns {string|null}
 */
export function readDshPresetFile(presetId, spawnCmd) {
  const file = resolveDshPresetFile(presetId, spawnCmd);
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    logDebug('failed to read preset file', file, error?.message || error);
    return null;
  }
}

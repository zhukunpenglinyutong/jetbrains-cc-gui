# Hooks compatibility and review checks

Codex declarations use PascalCase event names and nested per-handler entries in
`config.toml` or `hooks.json`. The enable preference is stored in the user's
`[hooks.state."<source-path>:<snake-event>:<group>:<handler>"]` table. Changing a
project hook's preference changes only the user configuration. The declaration
and referenced scripts are preserved. Native keys use physical source paths,
including a linked CODEX_HOME. An absent preference defaults to enabled.
Enabled preferences do not establish that a hook is trusted or will execute.

The reference is the pinned official `rust-v0.163.0` implementation:

- [Hook configuration and user state](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/hook_config.rs)
- [Native event labels and state keys](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/lib.rs)
- [Discovery and configuration layers](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/engine/discovery.rs)

Run the real CLI contract check with an installed 0.163.0 entry point:

```powershell
$env:CC_GUI_HOOKS_TEST_CLI = '<absolute path to codex.js or codex executable>'
node --test test/codex-hooks-native.test.mjs
```

The check uses a disposable home, strips inherited credential variables, and
only calls `hooks/list`. It verifies default enablement, exact native keys,
independent handlers, disable/re-enable preferences for both declaration formats,
and unchanged JSON declarations. It requires no account or model request and
does not execute hook commands. Missing CLI configuration is an explicit skip.
The catalog keeps runtime-version verification conservative because installed
CLI versions can differ. Codemoss directory scripts are not discovered, edited,
or toggled: no supported executor contract has been established. Unreleased
provider-directory state, quarantined scripts, and size/mtime revisions are not
accepted as compatibility formats.

Claude managed toggles retain matcherless wrappers and non-command handlers.
Only the root JSON hooks value is replaced; unrelated fields, nulls, escaped
strings and surrounding newline bytes are preserved. Private per-source user
storage holds state and at most 20 source backups, rather than writing backups
or state into a project. Multiple disabled siblings retain their original order
regardless of the order in which they are restored. Empty matcher groups are
removed while disabled; restoration retains their custom metadata. If an
identical event/matcher/handler has already been restored externally, enabling
removes only the private disabled record and preserves the source bytes.

Claude supports user `settings.json`, project `settings.json`, and project
`settings.local.json`; there is no user `settings.local.json` layer in the
[official settings scope reference](https://code.claude.com/docs/en/settings.md).
Toggling the shared project file requires an explicit confirmation, checked by
the backend against the actual target path. Linked files are read-only in both
catalog and mutation APIs; linked provider directories remain supported.
Disabled Claude records stay visible if their source disappears or becomes
invalid. Such records cannot be toggled until the source is repaired.

The editor hides full source and diff content until explicitly revealed because
provider configuration may contain credentials. Restore selects the last backup
created during the current editor session; it is not a backup browser. Toggle
operations remain pending until their correlated catalog refresh completes.

Validation completed on Windows during the October 31 deep review:

- The focused Hooks and handler suite discovers 42 cases: 41 pass and the
  POSIX-only permission case is skipped. Checkstyle passes. Coverage includes
  mixed bare handlers and multiple wrapped groups restored in different orders,
  duplicate external restoration, linked files, invalid sources, and shared-file
  confirmation.
- The full frontend run passes 2,958 cases, followed by a successful TypeScript
  build check. Regression coverage includes refused dispatches, timeouts, A/B/A
  source selection, stale responses, correlated refreshes, and late confirmations.
- All ten locales have the complete Hooks namespace. Source content and diffs
  remain hidden until the user explicitly reveals them.

Linux/macOS execution and interactive IDE/JCEF acceptance are not established by
these Windows checks.

# Native Codex compatibility checks

The compatibility workflow installs official CLI versions 0.146.0 and 0.163.0
in an isolated directory on Windows, macOS and Linux. These pinned versions
cover the legacy blocking-question protocol and the newer asynchronous tool
family. The matrix does not install or import the legacy Codex SDK.

Each native acceptance test creates its own home and workspace, strips inherited
API credentials and uses a local MCP fixture or a loopback Responses API fixture.
It never requires a user account or changes the user's Codex configuration.
The tests cover catalogs, effective permission scopes, persisted history,
ordinary chat, question answers, explicit cancellation and cold resume.

After installing bridge dependencies, run the same checks locally with Node.js
22.12 or newer. Set `CODEX_CLI_TEST_COMMAND` to a JSON argv array containing the
Node executable and the installed official `@openai/codex/bin/codex.js` path.
Set `CODEX_CLI_TEST_VERSION` to the installed version and
`CODEX_CLI_REQUIRE_REAL=1` so a missing CLI fails instead of skipping acceptance.

```sh
node --test --test-concurrency=2 ai-bridge/services/codex/*.test.js ai-bridge/services/codex/*.test.mjs ai-bridge/utils/sdk-loader.test.js
```

Version 0.146.0 has no asynchronous question tool family; its explicit capability
check keeps blocking questions covered and skips only the unsupported asynchronous
scenarios. Unit tests still exercise both protocol projections on every version.
Browser acceptance in `webview/e2e/codex-questions.spec.ts` covers desktop, narrow,
short and mobile viewports. CI results and local Windows results must be reported
separately; defining the matrix does not establish a passing run on other systems.

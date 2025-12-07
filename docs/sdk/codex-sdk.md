# Codex SDK

Aside from using Codex through the different interfaces like the Codex CLI, IDE extension or Codex Web, you can also programmatically control Codex.

This can be useful if you want to:

- Control Codex as part of your CI/CD pipeline
- Create your own agent that can engage with Codex to perform complex engineering tasks
- Build Codex into your own internal tools and workflows
- Integrate Codex within your own application

Just to name a few.

There are different ways to programmatically control Codex, depending on your use case.

- [TypeScript library](#typescript-library) — if you want to have full control over Codex from within your JavaScript or TypeScript server-side application
- [Using Codex CLI programmatically](#using-codex-cli-programmatically) — if you are just trying to send individual tasks to Codex
- [GitHub Action](#github-action) — if you want to trigger and control Codex from within your GitHub Actions workflow

## TypeScript library

The TypeScript library provides a more comprehensive way to control Codex from within your application.

The library is intended to be used server-side and requires at least Node.js v18.

### Installation

To get started, install the Codex SDK using `npm`:

```bash
npm install @openai/codex-sdk
```

### Usage

Start a thread with Codex and run it with your prompt.

```ts


const codex = new Codex();
const thread = codex.startThread();
const result = await thread.run(
  "Make a plan to diagnose and fix the CI failures"
);

console.log(result);
```

Call `run()` again to continue on the same thread, or resume a past thread by providing a `threadID`.

```ts
// running the same thread
const result = await thread.run("Implement the plan");

console.log(result);

// resuming past thread

const thread2 = codex.resumeThread(threadId);
const result2 = await thread.run("Pick up where you left off");

console.log(result2);
```

For more details, check out the [TypeScript repo](https://github.com/openai/codex/tree/main/sdk/typescript).

## Using Codex CLI programmatically

Aside from the library, you can also use the [Codex CLI](/codex/cli) in a programmatic way using the `exec` command. This runs Codex in non-interactive mode so you can hand it a task and let it finish without requiring inline approvals.

### Non-interactive execution

`codex exec "<task>"` streams Codex’s progress to stderr and prints only the final agent message to stdout. This makes it easy to pipe the final result into other tools.

```bash
codex exec "find any remaining TODOs and create for each TODO a detailed implementation plan markdown file in the .plans/ directory."
```

By default, Codex operates in a read-only sandbox and will not modify files or run networked commands.

### Allowing Codex to edit or reach the network

- Use `codex exec --full-auto "<task>"` to allow Codex to edit files.
- Use `codex exec --sandbox danger-full-access "<task>"` to allow edits and networked commands.

Combine these flags as needed to give Codex the permissions required for your workflow.

### Output control and streaming

While `codex exec` runs, Codex streams its activity to stderr. Only the final agent message is written to stdout, which makes it simple to pipe the result into other tools:

```bash
codex exec "generate release notes" | tee release-notes.md
```

- `-o`/`--output-last-message` writes the final message to a file in addition to stdout redirection.
- `--json` switches stdout to a JSON Lines stream so you can capture every event Codex emits while it is working. Event types include `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`. Item types cover agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, and plan updates.

```bash
codex exec --json "summarize the repo structure" | jq
```

Sample JSON stream (each line is a JSON object):

```jsonl
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}
```

### Structured output

Use `--output-schema <path>` to run Codex with a JSON Schema and receive structured JSON that conforms to it. Combine with `-o` to save the final JSON directly to disk.

`schema.json`

```json
{
  "type": "object",
  "properties": {
    "project_name": { "type": "string" },
    "programming_languages": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": ["project_name", "programming_languages"],
  "additionalProperties": false
}
```

```bash
codex exec "Extract project metadata" \
  --output-schema ./schema.json \
  -o ./project-metadata.json
```

The final JSON respects the schema you provide, which is especially useful when feeding Codex output into scripts or CI pipelines.

Example final output (stdout):

```json
{
  "project_name": "Codex CLI",
  "programming_languages": ["Rust", "TypeScript", "Shell"]
}
```

### Git repository requirement

Codex requires commands to run inside a Git repository to prevent destructive changes. Override this check with `codex exec --skip-git-repo-check` if you know the environment is safe.

### Resuming non-interactive sessions

Resume a previous non-interactive run to continue the same conversation context:

```bash
codex exec "Review the change for race conditions"
codex exec resume --last "Fix the race conditions you found"
```

You can also target a specific session ID with `codex exec resume <SESSION_ID>`.

### Authentication

`codex exec` reuses the CLI’s authentication by default. To override the credential for a single run, set `CODEX_API_KEY`:

```bash
CODEX_API_KEY=your-api-key codex exec --json "triage open bug reports"
```

`CODEX_API_KEY` is only supported in `codex exec`.

## GitHub Action

Use the Codex Exec GitHub Action (`openai/codex-action@v1`) when you need Codex to participate in CI/CD jobs, apply patches, or post reviews straight from a GitHub Actions workflow. The action installs the Codex CLI, starts the Responses API proxy when you provide an API key, and then runs `codex exec` under the permissions you specify.

Reach for the action when you want to:

- Automate Codex feedback on pull requests or releases without managing the CLI yourself.
- Gate changes on Codex-driven quality checks as part of your CI pipeline.
- Run repeatable Codex tasks (code review, release prep, migrations) from a workflow file.

Learn how to apply this to failing CI runs with the [autofix CI guide](/codex/autofix-ci) and explore the source in the [openai/codex-action repository](https://github.com/openai/codex-action).

### Prerequisites

- Store your OpenAI key as a GitHub secret (for example `OPENAI_API_KEY`) and reference it in the workflow.
- Ensure the job runs on a Linux or macOS runner; Windows is supported only with `safety-strategy: unsafe`.
- Check out your code before invoking the action so Codex can read the repository contents.
- Decide which prompts you want to run. You can provide inline text via `prompt` or point to a file committed in the repo with `prompt-file`.

### Example workflow

The sample workflow below reviews new pull requests, captures Codex’s response, and posts it back on the PR.

```yaml
name: Codex pull request review
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  codex:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    outputs:
      final_message: ${{ steps.run_codex.outputs.final-message }}
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/pull/${{ github.event.pull_request.number }}/merge

      - name: Pre-fetch base and head refs
        run: |
          git fetch --no-tags origin \
            ${{ github.event.pull_request.base.ref }} \
            +refs/pull/${{ github.event.pull_request.number }}/head

      - name: Run Codex
        id: run_codex
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          prompt-file: .github/codex/prompts/review.md
          output-file: codex-output.md
          safety-strategy: drop-sudo
          sandbox: workspace-write

  post_feedback:
    runs-on: ubuntu-latest
    needs: codex
    if: needs.codex.outputs.final_message != ''
    steps:
      - name: Post Codex feedback
        uses: actions/github-script@v7
        with:
          github-token: ${{ github.token }}
          script: |
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.payload.pull_request.number,
              body: process.env.CODEX_FINAL_MESSAGE,
            });
        env:
          CODEX_FINAL_MESSAGE: ${{ needs.codex.outputs.final_message }}
```

Replace `.github/codex/prompts/review.md` with your own prompt file or use the `prompt` input for inline text. The example also writes the final Codex message to `codex-output.md` for later inspection or artifact upload.

### Configure Codex Exec

Fine-tune how Codex runs by setting the action inputs that map to `codex exec` options:

- `prompt` or `prompt-file` (choose one) — inline instructions or a repository path to Markdown or text with your task. Consider storing prompts in `.github/codex/prompts/`.
- `codex-args` — extra CLI flags. Provide a JSON array (for example `["--full-auto"]`) or a shell string (`--full-auto --sandbox danger-full-access`) to allow edits, streaming, or MCP configuration.
- `model` and `effort` — pick the Codex agent configuration you want; leave empty for defaults.
- `sandbox` — match the sandbox mode (`workspace-write`, `read-only`, `danger-full-access`) to the permissions Codex needs during the run.
- `output-file` — save the final Codex message to disk so later steps can upload or diff it.
- `codex-version` — pin a specific CLI release. Leave blank to use the latest published version.
- `codex-home` — point to a shared Codex home directory if you want to reuse config files or MCP setups across steps.

### Manage privileges

Codex inherits substantial access on GitHub-hosted runners unless you restrict it. Use these inputs to control exposure:

- `safety-strategy` (default `drop-sudo`) removes `sudo` before running Codex. This is irreversible for the job and protects secrets in memory. On Windows you must set `safety-strategy: unsafe`.
- `unprivileged-user` pairs `safety-strategy: unprivileged-user` with `codex-user` to run Codex as a specific account. Ensure the user can read and write the repository checkout (see `.cache/codex-action/examples/unprivileged-user.yml` for an ownership fix).
- `read-only` keeps Codex from changing files or using the network, but it still runs with elevated privileges. Do not rely on `read-only` alone to protect secrets.
- `sandbox` limits filesystem and network access within Codex itself. Choose the narrowest option that still lets the task complete.
- `allow-users` and `allow-bots` restrict who can trigger the workflow. By default only users with write access can run the action; list extra trusted accounts explicitly or leave the field empty for the default behavior.

### Capture outputs

The action emits the last Codex message through the `final-message` output. Map it to a job output (as shown above) or handle it directly in later steps. Combine `output-file` with the uploaded artifacts feature if you prefer to collect the full transcript from the runner. When you need structured data, pass `--output-schema` through `codex-args` to enforce a JSON shape.

### Security checklist

- Limit who can start the workflow. Prefer trusted events or explicit approvals instead of allowing everyone to run Codex against your repository.
- Sanitize prompt inputs from pull requests, commit messages, or issue bodies to avoid prompt injection. Review HTML comments or hidden text before feeding it to Codex.
- Protect your `OPENAI_API_KEY` by keeping `safety-strategy` on `drop-sudo` or moving Codex to an unprivileged user. Never leave the action in `unsafe` mode on multi-tenant runners.
- Run Codex as the last step in a job so subsequent steps do not inherit any unexpected state changes.
- Rotate keys immediately if you suspect the proxy logs or action output exposed secret material.

### Troubleshooting

- **Only one of prompt or prompt-file may be specified** — remove the duplicate input so exactly one source remains.
- **responses-api-proxy did not write server info** — confirm the API key is present and valid; the proxy only starts when `openai-api-key` is set.
- **Expected sudo to be disabled, but sudo succeeded** — ensure no earlier step re-enabled `sudo` and that the runner OS is Linux or macOS. Re-run with a fresh job.
- **Permission errors after `drop-sudo`** — grant write access before the action runs (for example with `chmod -R g+rwX "$GITHUB_WORKSPACE"` or by using the unprivileged-user pattern).
- **Unauthorized trigger blocked** — adjust `allow-users` or `allow-bots` inputs if you need to permit service accounts beyond the default write collaborators.
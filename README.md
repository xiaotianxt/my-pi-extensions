# my-pi-extensions

Pi extensions and locally modified packages used by [xiaotianxt](https://github.com/xiaotianxt). Source-only export: no account credentials, personal settings, conversations, scheduled jobs, logs, caches, or previous Git history.

## Install

Requires Pi; standalone tests target **Pi 1.5.0**, Node 24+ and Python 3. Package snapshots retain their own dependency requirements.

```sh
pi install git:github.com/xiaotianxt/my-pi-extensions
```

The root manifest enables eight standalone extensions. Review them first and use `pi config` to disable unwanted ones. Do not load another copy of the same extension. Installing this collection does **not** install the six nested packages or enable Codex pooling / Orca integrations.

| Standalone extension | Purpose |
|---|---|
| `copy-code.ts` | Copy code blocks with `/copy-code` |
| `polished-footer.ts` | Compact status/footer rendering |
| `deepseek-usage.ts` | DeepSeek balance/status; `/deepseek-balance` |
| `openai-codex.ts` | Codex OAuth/usage integration; `/codex-provider-usage` |
| `codex-diagnostics.ts` | Local Codex diagnostic logging |
| `herdr-agent-state.ts` | Herdr agent lifecycle reporting |
| `herdr-tab-title.ts` | Model-generated Herdr tab titles; `/herdr-title` |
| `herdr-ui-state.ts` | Herdr UI state integration |
| `codex-pool.ts` (opt-in) | Account pool with `/codex`; needs private configuration and secrets |
| `orca-agent-status.ts` (opt-in) | Orca agent status integration |
| `orca-prefill.ts` (opt-in) | Orca-provided initial editor text |
| `orca-titlebar-spinner.ts` (opt-in) | Orca title activity marker |

Herdr/Orca extensions require their respective terminal integrations. Normally let Orca manage its own extensions; these files are snapshots, not a replacement updater. Tab-title generation can invoke the configured model; usage extensions contact provider APIs. Diagnostics write local logs. Review runtime behavior before enabling.

## Nested packages

Clone the repository, install dependencies in the package you want, then install that directory in Pi:

```sh
git clone https://github.com/xiaotianxt/my-pi-extensions.git
cd my-pi-extensions/packages/pi-btw
npm install --ignore-scripts
pi install "$PWD"
```

| Directory | Purpose |
|---|---|
| `packages/pi-memory` | Read/search local Pi, Codex, Claude Code and OpenCode history; requires Python 3 |
| `packages/pi-btw` | Read-only side questions against the current session snapshot |
| `packages/pi-gpt-search` | `codex-search`, `codex-research` and legacy `web`; uses active Pi Codex authentication |
| `packages/pi-antigravity` | Antigravity provider with local routing/transcript changes; Bun-based tests |
| `packages/pi-tick` | Persistent launchd/cron jobs; no personal schedules included |
| `packages/pi-bg-bash` | Background bash execution and completion notifications |

These are local source snapshots, not necessarily identical to an upstream release. See [THIRD_PARTY.md](THIRD_PARTY.md) for attribution. Existing upstream docs remain the reference for full package configuration; some commands/behavior differ in these modified snapshots.

The other two installed packages are distributed separately:

```sh
pi install git:github.com/xiaotianxt/bro@v1.4.1
pi install npm:pi-herdr-agents@3.7.2
```

## Optional account pool

`extensions/codex-pool.ts` and `lib/` must remain siblings. Install the extension file by absolute path only after configuring your own pool. It reads `CODEX_POOL_CONFIG` (default `~/.pi/agent/codex-pool.json`) and uses the `keychain-secret` command for secrets. The schema is defined by `parseConfig` in `lib/codex-pool.ts`; no real endpoint, account IDs or secret values are distributed. This is not a ready-to-use shared account service.

## Development and privacy

```sh
npm install --ignore-scripts
npm run check
# Package-specific deterministic tests:
cd packages/pi-memory && python3 -m unittest discover -s tests -v
```

See [VERIFICATION.md](VERIFICATION.md) for exact results and the known pi-tick test failures. Other package tests are defined in their `package.json`; install their dependencies first. Root typechecking covers the six explicitly listed extension entry points, not every vendored package. There is no live provider or terminal end-to-end test in CI.

The public snapshot uses an explicit source-file allowlist, fresh Git history, a GitHub noreply commit identity, a local personal-identifier scan, and Gitleaks. These checks reduce risk but cannot prove arbitrary future content is safe. Never copy an entire agent directory or runtime config into this repository. Keep secrets outside source control; do not commit memory caches, diagnostic logs or job transcripts. The code accesses local history/credentials at runtime where required; those data are not included here.

MIT for original code; third-party notices and licenses take precedence for their respective files.

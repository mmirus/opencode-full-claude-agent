# Full Claude Agent for OpenCode

An OpenCode V2 provider that runs Claude Code's native tools, settings, skills, plugins, and hooks through the Claude Agent SDK. Conversations appear in OpenCode. Native questions and approval requests are connected to OpenCode's existing question and permission dialogs.

This is a prototype targeting **OpenCode 2.2.5**, using **Claude Agent SDK 0.3.317**, tested with **Claude Code 2.1.316 and 2.1.317**. It registers separate providers and leaves the bundled Claude Agent available.

## Install

Install Claude Code and authenticate each Claude configuration directory first. The default executable is `claude` on `PATH`; `binaryPath` can select a different executable.

Installation uses a local source checkout. Clone or download this repository, then run these commands from the checkout directory:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

Add the plugin to your global `~/.config/opencode/opencode.jsonc` or a project's `opencode.jsonc`. Merge the entry into any existing `plugins` array. Replace the package path below with the absolute path to your checkout:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-full-claude-agent",
      "options": {
        "configDir": "~/.claude"
      }
    }
  ]
}
```

Start a new session and select **Full Claude Agent** in the model picker. Existing conversations from other providers cannot be imported. The default model IDs are `sonnet`, `opus`, and `haiku`, which Claude Code resolves. For example, `full-claude-agent/sonnet`.

## Multiple accounts in one server

Use named profiles to expose multiple selectable providers:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-full-claude-agent",
      "options": {
        "profiles": {
          "primary": { "configDir": "~/.claude" },
          "secondary": { "configDir": "~/.claude-secondary" }
        }
      }
    }
  ]
}
```

These register `full-claude-agent-primary` and `full-claude-agent-secondary`. Authenticate each directory before using its profile. Each native process receives its own `CLAUDE_CONFIG_DIR`; the plugin never changes the server's environment or `HOME`. A session stays bound to its original profile, directory, executable, plugin paths, and environment overrides. Start a new session to change that binding.

Profile IDs (the keys inside `profiles`) must match `^[a-z][a-z0-9-]*$`: start with a lowercase letter, then use only lowercase letters, digits, or hyphens. When `options.profiles` is present, it must be nonempty and cannot be combined with top-level `configDir`, `binaryPath`, `plugins`, `models`, or `env`; put those options inside each profile. `name` is allowed only inside a named profile.

Profile options:

| Option | Meaning |
| --- | --- |
| `configDir` | Claude settings and authentication directory. Defaults to inherited `CLAUDE_CONFIG_DIR`, then `~/.claude`. |
| `binaryPath` | Installed Claude executable; defaults to `claude`. |
| `plugins` | Additional local plugin directories containing `.claude-plugin/plugin.json`. Defaults to none. |
| `models` | Claude model IDs or CLI aliases to expose. Defaults to `sonnet`, `opus`, and `haiku`. |
| `env` | Per-process environment overrides. A `null` value removes an inherited variable. |
| `name` | Display name, available inside named profiles. |

`configDir` and each `plugins` entry expand `~` or a leading `~/` to the home directory, then resolve relative paths against OpenCode's location directory (`ctx.location.directory` passed to `parseProfiles`), not the plugin checkout or the directory containing `opencode.jsonc`. This also applies when `configDir` comes from inherited `CLAUDE_CONFIG_DIR`. Use absolute paths to avoid depending on the OpenCode location.

`binaryPath` uses the same path handling when it contains `/` or equals `~`, `.`, or `..`. Other values are bare executable names resolved through `PATH`.

`configDir` controls `CLAUDE_CONFIG_DIR` even if `env` supplies another value. Claude host-session variables inherited from a parent Claude process are removed after applying `env`, so the child does not join the parent's session.

Inherited API credentials can override Claude subscription authentication. If the server has API credentials but a profile should use its Claude login, remove the relevant inherited variables through that profile's `env`, for example `{"ANTHROPIC_API_KEY": null, "ANTHROPIC_AUTH_TOKEN": null, "CLAUDE_CODE_OAUTH_TOKEN": null}`. Endpoint and backend-selection variables also remain inherited unless explicitly overridden.

## Native plugins and commands

User, project, and local Claude settings load normally, including enabled installed plugins. `plugins` adds explicit local directories; it does not install marketplaces. Avoid adding a plugin directory that settings already enable.

Invoke skills conversationally, or forward a native command:

```text
/full-claude /your-plugin:your-command
```

Replace `/your-plugin:your-command` with a command provided by your Claude configuration. Select a Full Claude Agent model explicitly before using the forwarding command. Native command autocomplete is not implemented. Claude owns native command interpretation, tool execution, plugin hook matching, and `CLAUDE.md` loading. OpenCode's assembled system prompt and tool catalog are not sent to the native runtime.

The provider sets the SDK's PR attribution to `*Posted via OpenCode*` through per-query settings. Hard-coded signatures in repository instructions or plugin templates can still conflict with that default.

The adapter reports native tools as provider-executed so OpenCode does not execute them again. Native `AskUserQuestion` uses OpenCode's question executor. Permission requests that Claude sends to the SDK callback use OpenCode's permission evaluator; Claude's own settings and pre-tool hook decisions still run inside Claude Code. This callback is not an OpenCode permission check on every native tool invocation.

Question and permission mapping have offline test coverage. Live terminal testing verifies that a question appears in an already-open client and that selecting an option returns the answer to Claude. Terminal permission testing verifies both rejection and one-time approval of a native write. Graphical-client question and permission dialogs remain unverified.

## Native file-diff data

Successful native `Edit` and `Write` calls report their authoritative file diffs as provider-native metadata. The plugin does not execute the edit again, read the filesystem to reconstruct its result, or insert diff text into the assistant's answer.

**Stock OpenCode 2.2.5 does not render this metadata as inline diff cards.** Use its session-level diff/review view to inspect changes. The experimental per-tool metadata is retained for future client integrations; running this plugin does not require a modified OpenCode build.

Denied, failed, staged, malformed, oversized, and missing textual patches retain ordinary tool rows. Patches are limited to 256 KiB per tool result. A new-file patch may be generated from returned contents only when the native result explicitly reports file creation. Other filesystem changes, including changes made through shell commands, remain available through OpenCode's session-level diffs. Earlier tool records without this metadata are not backfilled.

## Foreground cross-provider delegation

Full Claude Agent exposes two in-process MCP tools:

- `mcp__full_claude_opencode__list_models` uses OpenCode's model search, which defaults to the newest model in each family. It returns base model references, release timestamps, and nested variant references. Set `all: true` to include older versions; `limit` and `offset` control pagination.
- `mcp__full_claude_opencode__delegate` runs an OpenCode subagent on the selected model and returns its session ID, model reference, and reply. The child starts in the parent OpenCode session's directory with fresh context, so the task prompt must include what the child needs.

For example, ask: “Have a Sol subagent review these changes.” Claude is instructed to use the newest matching base model unless you request another version or variant, and to report an unavailable model rather than substitute another one. Account selection follows the chosen provider/profile configuration.

Outgoing delegation has been live-tested with Claude Code 2.1.317. The bridge requires the native MCP tool-use identifier so host permissions and child execution can be associated with the actual Claude call.

Delegation reuses OpenCode's subagent executor, including its permission checks, depth limit, and foreground cancellation. It does not run the outer OpenCode tool-execution hook pipeline. Interrupting the parent stops the delegated child; child transcripts remain available. Background delegation and continuing an existing child through this bridge are not implemented. If a foreground delegate is manually backgrounded, the bridge interrupts it and reports that foreground execution is required.

Use native Claude `Agent` for workflows that depend on native subagent hooks. An OpenCode-managed child does not produce a native `Agent` transcript or a `SubagentStop` event in the parent Claude session. Claude's native toolset and configured MCP servers remain available alongside the delegation bridge.

## Session behavior and limits

- A primary OpenCode session keeps a streaming-input Claude process alive between turns. The native `Stop` hook's continuation finishes before OpenCode marks the turn complete.
- OpenCode plugin storage saves the Claude transcript ID and which user messages have already been submitted. Follow-ups, including after restart, resume the same Claude transcript and send only new user messages. Before sending a follow-up, the plugin checks that OpenCode has saved the matching completed assistant reply and that earlier conversation history has not changed.
- Cancellation interrupts Claude and drains the result before another submission. A timeout or crash with an unresolved submission is an uncertain outcome: the plugin rejects automatic replay rather than repeating possible tool side effects.
- Reloading or unloading the provider interrupts active native work. OpenCode reports the unload and retains returned tool outcomes. A tool without a final native result is marked interrupted with an unknown outcome; inspect its effects before retrying.
- Native background processes remain alive while the plugin is loaded. Their permission requests stay attached to the owning OpenCode session after the foreground turn ends. Completed native parent responses automatically appear as OpenCode assistant messages without another user prompt or another Claude request. Delivery waits if a different provider is selected. Background tool activity is not streamed while the host is idle.
- Changing model or effort while the native process is alive requires a new session. Native background work is not terminated merely to change a model.
- Claude owns native compaction. OpenCode compaction, forks, rewind, existing-conversation import, and auxiliary `session.generate` requests are unsupported. Titles use the initial prompt without an additional model request.
- OpenCode custom-agent instructions and plan-mode behavior are not propagated to Claude. The native query starts in Claude's default permission mode and uses Claude's own instructions and settings. Host integrations beyond the question, permission, and delegation bridges described above are not forwarded.
- OpenCode sessions can delegate to a Full Claude Agent model through OpenCode's subagent tool. Full Claude Agent sessions can use the MCP delegation bridge for foreground OpenCode children, while native `Agent` remains available for Claude subagents.
- A queued follow-up can start without waiting for OpenCode's execution-completion event, but only after the matching completed assistant reply is available. If that reply is missing, incomplete, or belongs to another response, the plugin rejects the follow-up without replaying the previous prompt. For older saved sessions, resume is supported when the plugin already recorded the matching completed OpenCode reply; otherwise, start a new session. Completed actions are not replayed to recover an older session.
- Usage reports per-turn main-agent tokens. Subagent and auxiliary tokens are excluded; cumulative native usage must not be added again on each host turn. Displayed model prices are unspecified.
- Aborting a permission request prevents the native action, but OpenCode's public `permission.assert` API cannot cancel its pending permission form.

## Verification

```sh
bun run check
bun test
```

The offline suite covers native event conversion, hook fixtures, input validation, per-account environments, questions, permissions, cancellation, prompt replay prevention, and session restart state. The tests use an injected native query where model execution is unnecessary.

Run the opt-in native integration smoke against a disposable project:

```sh
FULL_CLAUDE_LIVE=1 FULL_CLAUDE_RESUME=1 FULL_CLAUDE_MODEL=haiku \
  CLAUDE_CONFIG_DIR="$HOME/.claude" bun run scripts/live-smoke.ts
```

This makes model calls using the selected account. It verifies plugin loading, `SessionStart`, pre-tool denial, post-tool context, `Stop` continuation, `SubagentStop` transcript access, and resume. See [fixture instructions](test/fixtures/README.md) for confinement and diagnostics.

To verify package loading and restart/resume through the installed OpenCode executable:

```sh
FULL_CLAUDE_LIVE=1 FULL_CLAUDE_CONFIG_DIR="$HOME/.claude" bun run test:host
```

The host smoke uses a temporary OpenCode configuration and database. Its two no-tools turns must recall the same marker across separate standalone server processes.

Additional integration checks:

```sh
FULL_CLAUDE_LIVE=1 FIRST_CLAUDE_CONFIG_DIR="$HOME/.claude" \
  SECOND_CLAUDE_CONFIG_DIR="$HOME/.claude-secondary" bun run test:shared
FULL_CLAUDE_LIVE=1 bun run scripts/cancel-smoke.ts
FULL_CLAUDE_LIVE=1 FULL_CLAUDE_CONFIG_DIR="$HOME/.claude" bun run scripts/checkpoint-smoke.ts
FULL_CLAUDE_LIVE=1 FULL_CLAUDE_CONFIG_DIR="$HOME/.claude" bun run scripts/background-permission-smoke.ts
FULL_CLAUDE_LIVE=1 FULL_CLAUDE_CONFIG_DIR="$HOME/.claude" bun run scripts/reload-smoke.ts
FULL_CLAUDE_LIVE=1 bun run test:permission
FULL_CLAUDE_LIVE=1 bun run test:diff
bun run scripts/probe-accounts.ts "$HOME/.claude" "$HOME/.claude-secondary"
```

The shared-server smoke requires `SECOND_CLAUDE_CONFIG_DIR`; `FIRST_CLAUDE_CONFIG_DIR` defaults to `~/.claude`. It runs concurrent named profiles, native tool/hook checks, and another turn on the same session. The cancellation smoke interrupts a native Bash call and checks that the same Claude session accepts a follow-up.

The permission smoke uses `full-claude-agent/haiku` on the running OpenCode server. It creates a disposable project with explicit approval rules, rejects the test session's write request through the API, and verifies that the file stays absent and the native turn completes normally. The session and diagnostic directory remain available for inspection.

The diff smoke checks real native edits, file creation, and overwrite metadata, plus rejected-write and failed-edit exclusions. It uses a disposable directory and retains the session for inspection through the API and session-level diff view.

To test outgoing delegation, supply an exact child model available on your running OpenCode server:

```sh
FULL_CLAUDE_LIVE=1 FULL_CLAUDE_DELEGATE_MODEL="provider/model" bun run test:delegation
FULL_CLAUDE_LIVE=1 FULL_CLAUDE_DELEGATE_MODEL="provider/model" bun run test:delegation:cancel
```

Replace `provider/model` with the model you intend to use. `FULL_CLAUDE_PARENT_MODEL` defaults to `full-claude-agent/haiku`. Set `FULL_CLAUDE_DELEGATE_QUERY` to a family name, such as `Sol`, to test discovery independently of the exact expected child model. These checks create disposable sessions on the running server and make model calls through both providers. The completion test verifies the child's actual model and returned reply; the cancellation test interrupts the parent after the child starts and waits for both sessions to finish cleanup. Session permissions deny ordinary host tools and allow only the delegation bridge and the general subagent. Native tools and user hooks are not OS-sandboxed.

Integration scripts use the OS temporary directory by default. Set `FULL_CLAUDE_TEMP_DIR` to choose another parent directory. The host and shared-server scripts require a POSIX environment because they use process groups for cleanup.

Disposable working directories are not sandboxes. The shared-server smoke exposes the native tool preset with automatic host approvals; it does not use the fixture smoke's programmatic tool restrictions. Existing user hooks, plugins, and MCP startup processes can run in these checks.

The account probe initializes Claude without submitting a model prompt and compares hashed account identities. By default, it omits email addresses and organizations. To identify the accounts, explicitly opt in to printing the SDK's `accountInfo` email and organization alongside each configuration directory, backend, subscription, version, API key source, and identity hash:

```sh
bun run scripts/probe-accounts.ts --show-identity "$HOME/.claude" "$HOME/.claude-secondary"
```

Usage: `bun run scripts/probe-accounts.ts [--show-identity] <config-dir> [<other-config-dir> ...]`. Missing SDK identity fields are omitted; the probe does not infer them. Neither mode prints credentials or token values. The probe still loads user settings and can start configured integrations. Configuration paths, identity hashes, opted-in email/organization output, and retained integration-test diagnostics should be treated as private; do not commit or publish them.

### Verified through 2026-11-04

- [x] TypeScript check and offline test suite.
- [x] Native fixture hooks, plugin discovery, transcript access, and resume through the installed Claude CLI.
- [x] Package loading and transcript resume across installed OpenCode standalone server restarts.
- [x] Concurrent profiles on one isolated OpenCode server, with native `Read`, denied `Write`, foreground `Agent`, hook continuation, and same-session follow-up.
- [x] Two Claude configuration directories verified to resolve to distinct authenticated account identities.
- [x] Native cancellation drains before a follow-up on the same Claude session.
- [x] Live terminal question delivery and selection through OpenCode's existing dialog.
- [x] Plain permission rejection blocks a native write, completes the turn, and displays a settled tool error rather than a spinner.
- [x] Terminal permission dialogs: rejection leaves the file absent; one-time approval writes the expected contents.
- [x] Foreground cross-provider delegation from an OpenCode session to Full Claude Agent Opus, with the child response returned to the parent.
- [x] Foreground delegation from Full Claude Agent to an OpenCode model, including current-generation selection from a family-name query and the child response returned to Claude.
- [x] Interrupting a Full Claude parent stops its delegated OpenCode child; both sessions finish cancellation cleanup.
- [x] Native Edit/Write diff metadata, with rejected and failed operations excluded.
- [x] Native background permission approval and rejection, native hooks, and automatic delivery of the parent's completed report without another user prompt.
- [ ] Graphical-client question and permission dialogs. Mapping and cancellation have offline coverage.
- [ ] End-to-end pull-request creation and review workflows. The live tests use disposable fixtures and do not create or publish pull requests.

These are recorded validation results for the versions above, not a guarantee of compatibility with every third-party plugin or workflow. The test scripts are included; private run artifacts are not.

## License

This plugin is [MIT-licensed](LICENSE). Claude Code, the Claude Agent SDK, OpenCode, and third-party plugins remain subject to their own licenses and service terms.

## Design references

- [OpenCode 2.2.5 AI SDK plugin hooks](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/plugin/src/promise/aisdk.ts)
- [OpenCode server plugin API](https://opencode.ai/v2/docs/build/plugins/server)
- [T3 Claude query options](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1526-L1684)
- [T3 per-instance Claude home](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/apps/server/src/provider/Drivers/ClaudeHome.ts)

T3 is the reference for native execution plus host UI integration. Claude's native `Agent` tool runs subagents and their lifecycle hooks.

# Native Claude hook fixture

Offline contract checks (no model calls):

```sh
bun test test/fixtures/hooks.test.ts
bun run scripts/live-smoke.ts # skips unless explicitly enabled
```

Paid live checks, after reviewing the selected account's user hooks:

```sh
FULL_CLAUDE_LIVE=1 bun run scripts/live-smoke.ts
FULL_CLAUDE_LIVE=1 CLAUDE_CONFIG_DIR="$HOME/.claude-secondary" FULL_CLAUDE_EXPECT_EMAIL='you@example.com' bun run scripts/live-smoke.ts
FULL_CLAUDE_LIVE=1 FULL_CLAUDE_SCENARIO=native FULL_CLAUDE_RESUME=1 bun run scripts/live-smoke.ts
```

The default `plugin` scenario loads a copied local plugin through SDK `plugins`. The `native` scenario registers the same command hooks in the disposable project's `.claude/settings.json`, without loading the fixture plugin. Both scenarios use native SDK `query`, not the OpenCode adapter. Passing these checks does not establish adapter compatibility.

`settingSources` is always `user`, `project`, and `local`. Project and local settings load from the disposable fixture project. Existing user settings and plugins remain enabled. Account hooks, plugin commands, and MCP startup processes can run with the user's credentials; review those configurations before opting in. The SDK can write normal session transcripts under the selected Claude config directory. The harness itself does not change account settings, authentication, or existing repositories. User hooks are not OS-sandboxed.

Controls:

- `FULL_CLAUDE_BINARY`: executable path or command; defaults to `claude`.
- `CLAUDE_CONFIG_DIR`: optional existing Claude account/config directory; `HOME` is unchanged.
- `FULL_CLAUDE_EXPECT_EMAIL`: optional account identity assertion; email is not printed in the summary.
- `FULL_CLAUDE_SCENARIO`: `plugin` (default) or `native`.
- `FULL_CLAUDE_RESUME=1`: adds one resumed query; disabled by default to avoid another paid turn.
- `FULL_CLAUDE_MODEL`: optional native model override; otherwise uses the account default.
- `FULL_CLAUDE_BUDGET_USD`: positive per-query estimated budget, default `1`. This is an SDK limit, not a billing guarantee. Resume cost output can include prior session cost.
- `FULL_CLAUDE_TEMP_DIR`: parent directory for a new unique fixture directory; defaults to the OS temporary directory.
- `FULL_CLAUDE_FIXTURE_RUNTIME`: Node or Bun executable for command hooks; defaults to the smoke script's runtime. Standalone fixture plugin hooks default to `node`.

The live run uses one main query and one native synchronous subagent. The main query has a 12-turn limit and a three-minute timeout. Only `Read`, `Write`, and `Agent` are exposed to the main agent. The reviewer has only `Read` and is instructed not to use tools.

A programmatic `PreToolUse` guard restricts reads to the fixture input, writes to one attempted `denied.txt` sentinel, and delegation to one foreground fixture reviewer. The denial assertion uses the command hook's own log, not the guard. Shell and network tools are not exposed to the model. These restrictions apply to this fixture harness, not the other integration scripts or user hooks.

Expected live criteria:

- The fixture plugin appears exactly once in initialization (`plugin` scenario).
- `SessionStart` logs the native session ID, and its context token reaches the final result.
- Command `PreToolUse` denies the attempted `Write`; `denied.txt` does not exist.
- Command `PostToolUse` supplies a token absent from the user prompt and input file; that token reaches the final result.
- `Stop` returns `decision: block` exactly once per session, then runs again without blocking; its continuation token reaches the final result.
- Both the native agent transcript and `last_assistant_message` contain the expected review token when `SubagentStop` runs.
- Optional resume retains the native session ID, prior hook context, and Stop state, and emits `SessionStart` with source `resume`.
- Optional account email assertion matches SDK `accountInfo()` under the selected child environment. A single run does not establish concurrent account isolation.

Every hook appends JSONL to `hooks.jsonl` under `FULL_CLAUDE_FIXTURE_DIR`. Entries include `hook_event_name`, `session_id`, transcript availability, marker presence, and applicable tool, denial, context, and Stop fields. Stop state is keyed by a hash of the session ID. The hook script requires an existing absolute fixture state directory and uses only Node built-ins; no `jq` is required.

The printed fixture directory is retained for inspection, including SDK events, the copied plugin, and disposable project settings. Event files and native transcripts may contain account-provided context; treat them as private. Delete only that unique fixture directory when finished. The script does not delete native Claude transcripts.

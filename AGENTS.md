# Agent notes

## Development and live checkouts

OpenCode loads this plugin from the checkout that `~/.config/opencode/plugins/00-full-claude-agent` resolves to. When that checkout's source files change, OpenCode re-imports the plugin, and the re-import interrupts every active Full Claude turn, including the turn that made the change.

- Develop and commit in this repository's development checkout or a worktree of it. Before editing, run `readlink -f ~/.config/opencode/plugins/00-full-claude-agent`; if it resolves to the directory you are editing, stop and tell the user, because your edits will interrupt Full Claude sessions.
- Never edit, check out, or install dependencies in the live checkout (normally `~/git/opencode-full-claude-agent-live`). It changes only through `scripts/deploy-live.sh`.
- Do not run `scripts/deploy-live.sh` from any agent session. Deploying interrupts every active Full Claude turn, including sessions on other models that are not running Full Claude themselves. When committed work should take effect in OpenCode, tell the user to run `scripts/deploy-live.sh` from a terminal while no Full Claude turn is active.

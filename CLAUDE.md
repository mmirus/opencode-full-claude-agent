# Agent notes

- OpenCode loads this plugin from the checkout that `~/.config/opencode/plugins/00-full-claude-agent` resolves to. When a Full Claude session runs in that checkout, editing its source files makes OpenCode re-import the plugin and interrupts the session's own turn. Check with `readlink -f ~/.config/opencode/plugins/00-full-claude-agent`; if it resolves to the directory you are editing, do the work in a separate git worktree instead.
- Do not run `scripts/deploy-live.sh` from a Full Claude session; deploying interrupts every active Full Claude turn. Tell the user to run it from a terminal.

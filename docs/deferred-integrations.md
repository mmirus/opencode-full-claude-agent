# Deferred provider integrations

These items are outside the OpenCode 2.2.7 compatibility and native-status update. Native Claude remains responsible for execution, hooks, permissions, and compaction.

## Native-looking tool cards

The `prototype/native-tool-cards-v227` and `prototype/bash-command-provenance` branches retain the stock-TUI presentation experiments. Bash requested/observed-command labeling is implemented; the following tool-card extensions remain deferred.

Blanket Write mapping is unsuitable: the stock card says “Wrote” for staged success and previews requested content when a hook changed the actual operation. Plugin-owned metadata does not correct that label. Preserve truthful outcomes before choosing a richer presentation. The prototype stays outside the production branch.

Read/Glob/Grep mappings have separate tradeoffs: stock TUI cards hide ordinary result text that the generic card can expose. GUI Edit can preview requested replacement strings, but those strings do not establish the complete applied patch. Native Agent IDs are not OpenCode child-session IDs; do not create false navigation links.

The [2.2.7 provider-result path](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/session/runner/publish-llm-event.ts#L518-L525) stores provider metadata as `native`, not local-tool `state.metadata`. Exact applied-patch cards still need a supported rendering contract or a dedicated view. The [GUI CodeBlock registry](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/plugin/src/gui/registries.ts#L684-L768) applies to Markdown-rendered content; it does not replace arbitrary tool cards. A GUI companion panel could render the existing authoritative patches without inserting them into assistant messages.

## Native runtime features

- Live model/effort changes and process handover require native-turn and background-task ownership rules. Stock Claude Agent's parked-tool and idle-retirement machinery assumes OpenCode-owned tools and cannot be copied unchanged.
- Context windows and API pricing require account-sensitive discovery. Publishing finite context limits can enable host compaction, which Full Claude rejects; subscription and custom-gateway usage must not receive invented catalog prices.
- Stock fallback-disabling environment flags need a concrete native reproduction before adoption. Preserve the native behavior the provider exists to expose.

See the [bundled provider at 2.2.7](https://github.com/anomalyco/opencode/tree/v2.2.7/packages/core/src/plugin/provider/claude-agent) for the reference implementation, not a replacement execution model.

## Host extension boundaries

The [experimental job API](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/protocol/src/groups/job.ts#L16-L45) lists core jobs; it cannot adopt native Claude tasks. `opencode run` waits on those core jobs, not the plugin's task registry. Core task-inventory parity needs an upstream external-task contract.

The [TUI config watcher](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/tui/src/config/index.tsx#L363-L371) still watches the containing directory. Editing an out-of-tree symlink target can miss the client reload notification. Provider API success alone does not verify that a running client loaded its companion UI.

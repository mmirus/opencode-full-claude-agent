import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { NativeTasks, type NativeTask } from "./task-rpc.js"
import { taskReads } from "./task-ui-rpc.js"
import { outputNotice, taskIndicator, taskElapsed, taskLine, unavailableTasks, visibleTasks } from "./task-ui-state.js"

const panelName = "full-claude-agent.tasks"

function taskFeed(context: Context, sessionID: () => string) {
  const [tasks, setTasks] = createSignal<NativeTask[]>([])
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  let refresh = async () => {}
  createEffect(() => {
    const id = sessionID()
    const location = context.data.session.get(id)?.location ?? context.location ?? context.data.location.default()
    const rpc = context.client.rpc(NativeTasks)
    const abort = new AbortController()
    const reads = taskReads(rpc, { location, signal: abort.signal })
    let pending = false
    let again = false
    setTasks([])
    setError(undefined)
    setLoading(true)
    refresh = async () => {
      if (pending) { again = true; return }
      pending = true
      try {
        const result = await reads.list({ sessionID: id })
        if (!abort.signal.aborted) { setTasks(result.tasks); setError(undefined) }
      } catch {
        if (!abort.signal.aborted) {
          setTasks(unavailableTasks)
          setError("Task status unavailable. Press r to retry.")
        }
      } finally {
        pending = false
        if (!abort.signal.aborted) {
          setLoading(false)
          if (again) { again = false; void refresh() }
        }
      }
    }
    const changed = rpc.events.on("changed", (event) => {
      if (event.data.sessionID === id && event.location.directory === location.directory) void refresh()
    }, { signal: abort.signal })
    const reconnect = context.data.on("server.connected", () => {
      setTasks(unavailableTasks)
      setError("Task status unavailable. Refreshing…")
      void refresh()
    })
    // RPC subscriptions are live-only; recover events missed during a disconnect.
    const fallback = setInterval(() => void refresh(), 30_000)
    void refresh()
    onCleanup(() => { abort.abort(); changed(); reconnect(); clearInterval(fallback) })
  })
  return { tasks, error, loading, refresh: () => refresh() }
}

function Indicator(props: { sessionID: string }) {
  const context = usePlugin()
  const feed = taskFeed(context, () => props.sessionID)
  const label = createMemo(() => taskIndicator(feed.tasks(), !!feed.error()))
  return <Show when={label()}>
    <text fg={feed.error() ? context.theme.text.feedback.warning.base : context.theme.text.muted} onMouseDown={() => context.ui.panel.open(panelName)}>
      {label()}
    </text>
  </Show>
}

function TaskPanel(props: { panel: PanelInput }) {
  const context = usePlugin()
  const feed = taskFeed(context, () => props.panel.sessionID)
  const [ambient, setAmbient] = createSignal(false)
  const tasks = createMemo(() => visibleTasks(feed.tasks(), ambient()))
  const [selectedID, setSelectedID] = createSignal<string>()
  const selected = createMemo(() => tasks().find((task) => task.id === selectedID()) ?? tasks()[0])
  createEffect(() => {
    const list = tasks()
    if (!list.some((task) => task.id === selectedID())) setSelectedID(list[0]?.id)
  })
  const [now, setNow] = createSignal(Date.now())
  const [output, setOutput] = createSignal("")
  const [outputNote, setOutputNote] = createSignal("")
  const [stopPending, setStopPending] = createSignal(false)
  const [stopNote, setStopNote] = createSignal("")
  const [outputRevision, setOutputRevision] = createSignal(0)
  const selectedKey = createMemo(() => selected()?.id)
  const selectedState = createMemo(() => selected()?.state)
  const outputKey = createMemo(() => JSON.stringify([
    selected()?.id, selected()?.state, selected()?.hasOutput, props.panel.focused,
    props.panel.sessionID, context.data.session.get(props.panel.sessionID)?.location ?? context.location ?? context.data.location.default(),
    outputRevision(),
  ]))
  let outputBox: ScrollBoxRenderable | undefined
  let taskBox: ScrollBoxRenderable | undefined
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(clock))

  createEffect(on(selectedKey, () => {
    setStopNote("")
    setStopPending(false)
    outputBox?.scrollTo(0)
  }))
  createEffect(on(selectedState, (state) => {
    if (state !== "running") setStopNote("")
  }))
  createEffect(on(outputKey, () => {
    const task = selected()
    const focused = props.panel.focused
    const sessionID = props.panel.sessionID
    const location = context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default()
    const rpc = context.client.rpc(NativeTasks)
    const abort = new AbortController()
    const reads = taskReads(rpc, { location, signal: abort.signal })
    setOutput("")
    setOutputNote(task ? "Loading output…" : "")
    let pending = false
    async function read() {
      if (!task || pending || abort.signal.aborted) return
      pending = true
      try {
        const result = await reads.output({ sessionID, id: task.id })
        if (abort.signal.aborted) return
        setOutput(result.text)
        setOutputNote(outputNotice(result))
      } catch {
        if (!abort.signal.aborted) setOutputNote("Output unavailable. Press r to retry.")
      } finally { pending = false }
    }
    if (focused) void read()
    else setOutputNote("Focus the panel to read output.")
    const poll = focused && task?.state === "running" ? setInterval(() => void read(), 2000) : undefined
    onCleanup(() => { abort.abort(); clearInterval(poll) })
  }))

  function move(delta: number) {
    const list = tasks()
    const index = list.findIndex((task) => task.id === selected()?.id)
    const task = list[Math.max(0, Math.min(list.length - 1, index + delta))]
    setSelectedID(task?.id)
    if (task) taskBox?.scrollChildIntoView(`claude-task-${task.id}`)
  }
  async function stop() {
    const task = selected()
    if (!task?.canStop || stopPending()) return
    const sessionID = props.panel.sessionID
    const location = context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default()
    setStopPending(true)
    try {
      const result = await context.client.rpc(NativeTasks).stop({ sessionID, id: task.id }, { location })
      if (selected()?.id === task.id) setStopNote(result.requested
        ? selected()?.state === "running" ? "Stop requested; awaiting Claude status." : ""
        : "Stop was not requested.")
      await feed.refresh()
    } catch {
      if (selected()?.id === task.id) setStopNote("Stop request failed. Press s to retry.")
    } finally { setStopPending(false) }
  }

  context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { bind: "up", run: () => move(-1) },
      { bind: "down", run: () => move(1) },
      { bind: "pageup", run: () => outputBox?.scrollBy(-10) },
      { bind: "pagedown", run: () => outputBox?.scrollBy(10) },
      { bind: "r", title: "Refresh tasks", run: async () => { await feed.refresh(); setOutputRevision((value) => value + 1) } },
      { bind: "s", title: "Request stop", enabled: () => !!selected()?.canStop && !stopPending(), run: stop },
      { bind: "a", title: "Toggle ambient tasks", run: () => { setAmbient((value) => !value) } },
      { bind: "f", title: "Toggle fullscreen", run: props.panel.toggleFullscreen },
      { bind: "escape", title: "Close tasks", run: props.panel.close },
    ],
  }))

  return <box flexDirection="column" height="100%" flexGrow={1} flexShrink={1} minHeight={0} paddingX={1} onMouseDown={props.panel.focus}>
    <text flexShrink={0} fg={context.theme.text.base}>Claude tasks</text>
    <text flexShrink={0} fg={context.theme.text.muted} wrapMode="word">↑/↓ select · PgUp/PgDn output · r refresh · f fullscreen · esc close</text>
    <text flexShrink={0} fg={context.theme.text.muted} onMouseDown={() => setAmbient((value) => !value)}>
      {`a ${ambient() ? "Hide" : "Show"} ambient tasks`}
    </text>
    <Show when={feed.error()}><text flexShrink={0} fg={context.theme.text.feedback.warning.base}>{feed.error()}</text></Show>
    <Show when={tasks().length} fallback={<text flexShrink={0} fg={context.theme.text.muted}>{feed.loading() ? "Loading tasks…" : "No Claude tasks in this session."}</text>}>
      <scrollbox ref={taskBox} maxHeight="40%" minHeight={3} flexShrink={1}>
        <For each={tasks()}>{(task) => <text
          id={`claude-task-${task.id}`}
          flexShrink={0}
          fg={task.id === selected()?.id ? context.theme.text.base : context.theme.text.muted}
          wrapMode="word"
          onMouseDown={() => setSelectedID(task.id)}
        >{`${task.id === selected()?.id ? "›" : " "} ${taskLine(task)}\n  ${task.state} · ${taskElapsed(task, now())}${task.ambient ? " · ambient" : ""}`}</text>}</For>
      </scrollbox>
      <Show when={selected()}>{(task) => <>
        <text flexShrink={0} fg={context.theme.text.muted} wrapMode="word">{`${task().kind} · ${task().taskID}`}</text>
        <Show when={task().detail}><text flexShrink={0} maxHeight={3} fg={context.theme.text.muted} wrapMode="word">{task().detail}</text></Show>
        <Show when={task().canStop}>
          <text flexShrink={0} fg={context.theme.text.feedback.warning.base} onMouseDown={() => void stop()}>{stopPending() ? "Requesting stop…" : "s Request stop"}</text>
        </Show>
        <Show when={stopNote() && !task().detail?.startsWith("Stop requested")}><text flexShrink={0} fg={context.theme.text.muted} wrapMode="word">{stopNote()}</text></Show>
        <text flexShrink={0} fg={context.theme.text.base}>Output</text>
        <Show when={outputNote()}><text flexShrink={0} fg={context.theme.text.muted} wrapMode="word">{outputNote()}</text></Show>
        <scrollbox ref={outputBox} flexGrow={1} flexBasis={0} minHeight={3}>
          <text fg={context.theme.text.base} wrapMode="word">{output()}</text>
        </scrollbox>
      </>}</Show>
    </Show>
  </box>
}

export default Plugin.define({
  id: "full-claude-agent.tasks.tui",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "full-claude-agent.tasks.open",
        title: "Open Claude tasks",
        group: "Claude",
        palette: true,
        slash: { name: "claude-tasks" },
        run: () => {
          if (!context.ui.panel.open(panelName)) context.ui.toast.show({ message: "Open a session to view Claude tasks." })
        },
      }],
    }))
    const indicator = context.ui.slot({ append: "session.composer.top", render: (props) => <Indicator sessionID={props.sessionID} /> })
    const panel = context.ui.slot({ append: "session.panel", render: (props) => <Show when={props.name === panelName}><TaskPanel panel={props} /></Show> })
    return () => { indicator(); panel() }
  },
})

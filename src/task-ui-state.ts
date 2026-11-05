import type { NativeTask } from "./task-rpc.js"

export function visibleTasks(tasks: readonly NativeTask[], ambient = false): NativeTask[] {
  return tasks.filter((task) => ambient || !task.ambient).toSorted((a, b) =>
    Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt || a.id.localeCompare(b.id))
}

export function runningCount(tasks: readonly NativeTask[]): number {
  return tasks.filter((task) => !task.ambient && task.state === "running").length
}

export function taskIndicator(tasks: readonly NativeTask[], unavailable: boolean): string | undefined {
  const count = runningCount(tasks)
  if (count > 0) return `Claude tasks: ${count} running`
  if (unavailable && tasks.some((task) => !task.ambient && task.state === "unknown")) return "Claude tasks: status unavailable"
}

export function outputNotice(output: { text: string; available: boolean; truncated: boolean; reason?: string }): string {
  if (!output.available) return output.reason ?? "Output unavailable"
  const notes = []
  if (output.truncated) notes.push("Showing bounded output (truncated).")
  if (!output.text) notes.push(output.reason ?? "No output yet.")
  return notes.join(" ")
}

export function taskElapsed(task: NativeTask, now: number): string {
  const end = task.finishedAt ?? (task.state === "running" ? now : task.updatedAt)
  const seconds = Math.max(0, Math.floor((end - task.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}

export function unavailableTasks(tasks: readonly NativeTask[]): NativeTask[] {
  return tasks.map((task) => task.state === "running" ? { ...task, state: "unknown", canStop: false } : task)
}

export function taskLine(task: NativeTask): string {
  return task.description.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim() || task.taskID
}

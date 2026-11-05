import { describe, expect, test } from "bun:test"
import type { NativeTask } from "../src/task-rpc.js"
import { outputNotice, runningCount, taskIndicator, taskElapsed, taskLine, unavailableTasks, visibleTasks } from "../src/task-ui-state.js"

function task(overrides: Partial<NativeTask> = {}): NativeTask {
  return {
    id: "one", sessionID: "session", providerID: "claude", taskID: "native-one",
    description: "Check build", kind: "bash", state: "running", startedAt: 1000,
    updatedAt: 3000, ambient: false, canStop: true, hasOutput: true, ...overrides,
  }
}

describe("Claude task display", () => {
  test("empty output preserves the server's redirected-log explanation", () => {
    expect(outputNotice({ text: "", available: true, truncated: false, reason: "Output was redirected to a log file." })).toBe("Output was redirected to a log file.")
    expect(outputNotice({ text: "", available: true, truncated: false })).toBe("No output yet.")
    expect(outputNotice({ text: "tail", available: true, truncated: true })).toBe("Showing bounded output (truncated).")
  })

  test("lost status remains visible only for previously known nonambient unknown tasks", () => {
    expect(taskIndicator(unavailableTasks([task()]), true)).toBe("Claude tasks: status unavailable")
    expect(taskIndicator([], true)).toBeUndefined()
    expect(taskIndicator(unavailableTasks([task({ ambient: true })]), true)).toBeUndefined()
    expect(taskIndicator([task({ state: "completed" })], true)).toBeUndefined()
    expect(taskIndicator([task({ state: "unknown" })], false)).toBeUndefined()
    expect(taskIndicator([task()], false)).toBe("Claude tasks: 1 running")
  })

  test("badge excludes ambient and terminal tasks", () => {
    expect(runningCount([task(), task({ ambient: true }), task({ state: "completed" }), task({ state: "unknown" })])).toBe(1)
  })

  test("default viewer keeps completed history, hides ambient, and puts running first", () => {
    const history = task({ id: "history", state: "completed", startedAt: 5000 })
    const running = task()
    const ambient = task({ id: "ambient", ambient: true })
    expect(visibleTasks([history, ambient, running])).toEqual([running, history])
    expect(visibleTasks([history, ambient, running], true)).toHaveLength(3)
  })

  test("elapsed time freezes at completion or last observation for unknown tasks", () => {
    expect(taskElapsed(task(), 65_000)).toBe("1m 4s")
    expect(taskElapsed(task({ state: "completed", finishedAt: 5000 }), 65_000)).toBe("4s")
    expect(taskElapsed(task({ state: "unknown" }), 65_000)).toBe("2s")
    expect(taskElapsed(task(), 0)).toBe("0s")
    expect(taskElapsed(task(), 3_662_000)).toBe("1h 1m")
  })

  test("unavailable status cannot leave a stale running badge or stop action", () => {
    const completed = task({ id: "done", state: "completed", canStop: false })
    const tasks = unavailableTasks([task(), completed])
    expect(tasks[0].state).toBe("unknown")
    expect(tasks[0].canStop).toBe(false)
    expect(tasks[1]).toBe(completed)
    expect(runningCount(tasks)).toBe(0)
  })

  test("task descriptions occupy a safe single line", () => {
    expect(taskLine(task({ description: "Build\nproject\tlog\x1b" }))).toBe("Build project log")
    expect(taskLine(task({ description: " " }))).toBe("native-one")
  })
})

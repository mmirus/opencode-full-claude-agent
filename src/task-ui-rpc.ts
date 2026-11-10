import type { RpcCallOptions, RpcClient } from "@opencode/client"
import type { NativeTasks } from "./task-rpc.js"

type TaskReads = Pick<RpcClient<typeof NativeTasks>, "list" | "output">

export function taskReads(rpc: TaskReads, options: RpcCallOptions & { signal: AbortSignal }) {
  async function read<T>(call: () => Promise<T>): Promise<T> {
    const delays = [100, 200, 400, 800, 1600]
    for (let attempt = 0; ; attempt++) {
      options.signal.throwIfAborted()
      try {
        return await call()
      } catch (error) {
        if (options.signal.aborted || !unavailable(error) || attempt === delays.length) throw error
        await delay(delays[attempt], options.signal)
      }
    }
  }
  return {
    list: (input: Parameters<TaskReads["list"]>[0]) => read(() => rpc.list(input, options)),
    output: (input: Parameters<TaskReads["output"]>[0]) => read(() => rpc.output(input, options)),
  }
}

function unavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "type" in error && error.type === "rpc.unavailable"
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

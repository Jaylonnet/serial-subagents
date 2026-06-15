import type { Plugin } from "@opencode-ai/plugin"

export interface Options {
  /**
   * Maximum time (ms) a `task` call may hold its slot before the
   * queue force-proceeds to the next call. Default 5 minutes.
   *
   * Acts as a safety net for the case where `tool.execute.after`
   * is never fired by opencode (e.g. user-cancel, internal error).
   * Set to 0 to fall back to a microtask release on the next tick.
   */
  timeoutMs?: number

  /**
   * Maximum number of `task` calls running in parallel. Default 1
   * (fully serial). Values <= 0 are clamped to 1.
   */
  concurrency?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_CONCURRENCY = 1
const TARGET_TOOL = "task"

interface PerCall {
  release: () => void
  finished: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const perCall = new Map<string, PerCall>()
let inFlight = 0
let concurrency = DEFAULT_CONCURRENCY
const waiters: Array<() => void> = []

export function clampOptions(opts: unknown): Required<Options> {
  const o = (opts ?? {}) as Partial<Options>
  const rawTimeout = Number(o.timeoutMs)
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= 0 ? rawTimeout : DEFAULT_TIMEOUT_MS
  const rawConcurrency = Number(o.concurrency)
  concurrency =
    Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.max(1, Math.floor(rawConcurrency))
      : DEFAULT_CONCURRENCY
  return { timeoutMs, concurrency }
}

export function acquire(): Promise<void> {
  if (inFlight < concurrency) {
    inFlight++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      inFlight++
      resolve()
    })
  })
}

export function release(): void {
  if (inFlight > 0) inFlight--
  const next = waiters.shift()
  if (next) next()
}

export function releaseForCall(callId: string, reason: "after" | "timeout" | "error"): void {
  const entry = perCall.get(callId)
  if (!entry) return
  if (entry.finished) return
  entry.finished = true
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  perCall.delete(callId)
  if (reason === "timeout") {
    console.warn(
      `[opencode-serial-subagents] ${TARGET_TOOL} call ${callId} did not complete within timeout; releasing slot to unblock queue.`,
    )
  }
  release()
  try {
    entry.release()
  } catch {
    // resolver already called; safe to ignore
  }
}

export default (async (_input, opts) => {
  const { timeoutMs } = clampOptions(opts)

  type TaskHook = (input: { tool: string; callID: string }) => Promise<void>

  const before: TaskHook = async (input) => {
    if (input.tool !== TARGET_TOOL) return
    const callId = input.callID
    if (!callId) return

    if (perCall.has(callId)) {
      // Duplicate hook fire for the same call: the slot is already held
      // by the original entry. Do nothing.
      return
    }

    let resolveGate!: () => void
    const gate = new Promise<void>((r) => {
      resolveGate = r
    })
    const entry: PerCall = { release: resolveGate, finished: false, timer: null }
    perCall.set(callId, entry)

    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => releaseForCall(callId, "timeout"), timeoutMs)
      if (entry.timer && typeof (entry.timer as { unref?: () => void }).unref === "function") {
        ;(entry.timer as { unref: () => void }).unref()
      }
    } else {
      queueMicrotask(() => releaseForCall(callId, "timeout"))
    }

    void gate
    await acquire()
  }

  const after: TaskHook = async (input) => {
    if (input.tool !== TARGET_TOOL) return
    const callId = input.callID
    if (!callId) return
    releaseForCall(callId, "after")
  }

  const error: TaskHook = async (input) => {
    if (input.tool !== TARGET_TOOL) return
    const callId = input.callID
    if (!callId) return
    releaseForCall(callId, "error")
  }

  return {
    "tool.execute.before": before,
    "tool.execute.after": after,
    "tool.execute.error": error,
  }
}) satisfies Plugin

export const __testing__ = {
  acquire,
  release,
  releaseForCall,
  perCall,
  getInFlight: () => inFlight,
  setInFlight: (n: number) => {
    inFlight = n
  },
  getWaiters: () => waiters,
  setConcurrency: (n: number) => {
    concurrency = n
  },
  reset: () => {
    perCall.clear()
    inFlight = 0
    waiters.length = 0
    concurrency = DEFAULT_CONCURRENCY
  },
  clampOptions,
}

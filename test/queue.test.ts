import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test"
import plugin, { __testing__, clampOptions } from "../index.ts"

const {
  acquire,
  release,
  releaseForCall,
  perCall,
  getInFlight,
  setInFlight,
  setConcurrency,
  reset,
} = __testing__

type Hooks = {
  "tool.execute.before": (input: { tool: string; callID: string }) => Promise<void>
  "tool.execute.after": (input: { tool: string; callID: string }) => Promise<void>
  "tool.execute.error": (input: { tool: string; callID: string }) => Promise<void>
}

async function makeHooks(opts: Record<string, unknown> | undefined): Promise<Hooks> {
  return (await plugin({} as Parameters<typeof plugin>[0], opts)) as unknown as Hooks
}

beforeEach(() => {
  reset()
})

// Suppress the timeout-warning console.warn for the whole suite.
const origWarn = console.warn
beforeAll(() => {
  console.warn = () => {}
})
afterAll(() => {
  console.warn = origWarn
})

describe("clampOptions", () => {
  test("negative timeout and zero concurrency fall back to defaults", () => {
    const a = clampOptions({ timeoutMs: -5, concurrency: 0 })
    expect(a.timeoutMs).toBe(5 * 60 * 1000)
    expect(a.concurrency).toBe(1)
  })

  test("NaN and non-numeric fields fall back to defaults", () => {
    const a = clampOptions({ timeoutMs: NaN, concurrency: "nope" })
    expect(a.timeoutMs).toBe(5 * 60 * 1000)
    expect(a.concurrency).toBe(1)
  })

  test("missing opts returns full defaults", () => {
    const a = clampOptions(undefined)
    expect(a.timeoutMs).toBe(5 * 60 * 1000)
    expect(a.concurrency).toBe(1)
  })

  test("valid options pass through", () => {
    const a = clampOptions({ timeoutMs: 1000, concurrency: 3 })
    expect(a.timeoutMs).toBe(1000)
    expect(a.concurrency).toBe(3)
  })
})

describe("semaphore primitives", () => {
  test("acquire increments inFlight up to concurrency", () => {
    setConcurrency(2)
    expect(getInFlight()).toBe(0)
    void acquire()
    void acquire()
    expect(getInFlight()).toBe(2)
  })

  test("acquire beyond concurrency is queued", () => {
    setConcurrency(1)
    void acquire()
    expect(getInFlight()).toBe(1)
    const c = acquire()
    expect(getInFlight()).toBe(1)
    release()
    return c.then(() => {
      expect(getInFlight()).toBe(1)
    })
  })

  test("FIFO ordering: queued acquires resolve in shift order", async () => {
    setConcurrency(1)
    void acquire()
    const order: string[] = []
    const b = acquire().then(() => order.push("B"))
    const c = acquire().then(() => order.push("C"))
    release() // wakes B; B's acquire increments inFlight back to 1
    await b
    release() // wakes C
    await c
    expect(order).toEqual(["B", "C"])
  })
})

describe("FIFO ordering through the hook (concurrency = 1)", () => {
  test("three calls execute in order A then B then C", async () => {
    const hooks = await makeHooks({ timeoutMs: 60_000, concurrency: 1 })
    const order: string[] = []

    const a = hooks["tool.execute.before"]({ tool: "task", callID: "A" }).then(() =>
      order.push("A-acquired"),
    )
    await a
    expect(getInFlight()).toBe(1)

    const b = hooks["tool.execute.before"]({ tool: "task", callID: "B" }).then(() =>
      order.push("B-acquired"),
    )
    const c = hooks["tool.execute.before"]({ tool: "task", callID: "C" }).then(() =>
      order.push("C-acquired"),
    )

    // B and C are queued
    expect(getInFlight()).toBe(1)
    expect(perCall.has("B")).toBe(true)
    expect(perCall.has("C")).toBe(true)

    await hooks["tool.execute.after"]({ tool: "task", callID: "A" })
    await b
    expect(getInFlight()).toBe(1)

    await hooks["tool.execute.after"]({ tool: "task", callID: "B" })
    await c
    expect(getInFlight()).toBe(1)

    await hooks["tool.execute.after"]({ tool: "task", callID: "C" })
    expect(getInFlight()).toBe(0)

    expect(order).toEqual(["A-acquired", "B-acquired", "C-acquired"])
  })
})

describe("concurrency = 2", () => {
  test("A and B run in parallel; C waits for one to finish", async () => {
    const hooks = await makeHooks({ timeoutMs: 60_000, concurrency: 2 })
    const order: string[] = []

    const a = hooks["tool.execute.before"]({ tool: "task", callID: "A" }).then(() =>
      order.push("A"),
    )
    const b = hooks["tool.execute.before"]({ tool: "task", callID: "B" }).then(() =>
      order.push("B"),
    )
    await Promise.all([a, b])
    expect(getInFlight()).toBe(2)
    expect(order).toEqual(["A", "B"])

    const c = hooks["tool.execute.before"]({ tool: "task", callID: "C" }).then(() =>
      order.push("C"),
    )
    expect(getInFlight()).toBe(2)

    await hooks["tool.execute.after"]({ tool: "task", callID: "A" })
    await c
    expect(order).toEqual(["A", "B", "C"])
    expect(getInFlight()).toBe(2)

    await hooks["tool.execute.after"]({ tool: "task", callID: "B" })
    await hooks["tool.execute.after"]({ tool: "task", callID: "C" })
    expect(getInFlight()).toBe(0)
  })
})

describe("timeout fallback", () => {
  test("successor proceeds when predecessor never fires after", async () => {
    const hooks = await makeHooks({ timeoutMs: 50, concurrency: 1 })
    const t0 = Date.now()

    await hooks["tool.execute.before"]({ tool: "task", callID: "A" })
    const b = hooks["tool.execute.before"]({ tool: "task", callID: "B" })
    expect(perCall.has("A")).toBe(true)

    await b
    const elapsed = Date.now() - t0
    expect(perCall.has("A")).toBe(false)
    expect(getInFlight()).toBe(1)
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  test("timeoutMs: 0 fires the microtask fallback so no call is wedged", async () => {
    const hooks = await makeHooks({ timeoutMs: 0, concurrency: 1 })
    const a = hooks["tool.execute.before"]({ tool: "task", callID: "A" })
    const b = hooks["tool.execute.before"]({ tool: "task", callID: "B" })
    await a
    await b
    // Allow microtasks to drain
    await new Promise((r) => setTimeout(r, 1))
    expect(perCall.has("A")).toBe(false)
    expect(perCall.has("B")).toBe(false)
  })
})

describe("idempotent release", () => {
  test("calling releaseForCall twice does not double-decrement inFlight", () => {
    setInFlight(1)
    perCall.set("X", { release: () => {}, finished: false, timer: null })

    releaseForCall("X", "after")
    expect(getInFlight()).toBe(0)
    releaseForCall("X", "after")
    expect(getInFlight()).toBe(0)
  })

  test("release after timeout is a no-op (entry already deleted)", () => {
    setInFlight(1)
    perCall.set("Y", { release: () => {}, finished: false, timer: null })
    releaseForCall("Y", "timeout")
    expect(getInFlight()).toBe(0)
    releaseForCall("Y", "after")
    expect(getInFlight()).toBe(0)
  })
})

describe("cancellation simulation (user-reported bug)", () => {
  test("successor proceeds via timeout after predecessor is interrupted", async () => {
    // The plugin applies a single `timeoutMs` to every call. The cancellation
    // path in opencode never fires `after`, so the predecessor's slot would
    // otherwise leak. The 30ms timer covers the predecessor; B's `after` is
    // called immediately after B's `before` resolves, well before B's own
    // 30ms timer fires.
    const hooks = await makeHooks({ timeoutMs: 30, concurrency: 1 })
    await hooks["tool.execute.before"]({ tool: "task", callID: "A" })
    const b = hooks["tool.execute.before"]({ tool: "task", callID: "B" })
    // Simulate cancel: do NOT call `after` for A.
    await new Promise((r) => setTimeout(r, 35)) // A's 30ms timer fires here
    await b // B's `before` resolved because A's timeout released the slot
    // Call B's `after` immediately. B's slot releases via `after`, not timer.
    await hooks["tool.execute.after"]({ tool: "task", callID: "B" })
    expect(perCall.has("A")).toBe(false)
    expect(perCall.has("B")).toBe(false)
  })
})

describe("non-task tools pass through", () => {
  test("fireBefore on bash is a no-op", async () => {
    const hooks = await makeHooks({ timeoutMs: 60_000, concurrency: 1 })
    await hooks["tool.execute.before"]({ tool: "bash", callID: "X" })
    expect(getInFlight()).toBe(0)
    expect(perCall.has("X")).toBe(false)
    await hooks["tool.execute.after"]({ tool: "bash", callID: "X" })
    expect(getInFlight()).toBe(0)
  })

  test("read, write, edit all pass through", async () => {
    const hooks = await makeHooks({ timeoutMs: 60_000, concurrency: 1 })
    for (const tool of ["read", "write", "edit", "glob", "grep", "webfetch"]) {
      await hooks["tool.execute.before"]({ tool, callID: `${tool}-1` })
      expect(getInFlight()).toBe(0)
    }
  })
})

describe("error hook releases slot", () => {
  test("releaseForCall with reason=error wakes the next waiter", async () => {
    setInFlight(1)
    perCall.set("A", { release: () => {}, finished: false, timer: null })
    const waiter = acquire()
    releaseForCall("A", "error")
    await waiter
    expect(getInFlight()).toBe(1)
  })

  test("tool.execute.error hook handler releases the slot", async () => {
    const hooks = await makeHooks({ timeoutMs: 60_000, concurrency: 1 })
    await hooks["tool.execute.before"]({ tool: "task", callID: "A" })
    expect(getInFlight()).toBe(1)
    const b = hooks["tool.execute.before"]({ tool: "task", callID: "B" })
    await hooks["tool.execute.error"]({ tool: "task", callID: "A" })
    await b
    expect(getInFlight()).toBe(1)
    await hooks["tool.execute.after"]({ tool: "task", callID: "B" })
    expect(getInFlight()).toBe(0)
  })
})

describe("duplicate hook fire is safe", () => {
  test("two before calls with the same callID share the same slot", async () => {
    const hooks = await makeHooks({ timeoutMs: 60_000, concurrency: 1 })
    const a1 = hooks["tool.execute.before"]({ tool: "task", callID: "dup" })
    const a2 = hooks["tool.execute.before"]({ tool: "task", callID: "dup" })
    await Promise.all([a1, a2])
    expect(getInFlight()).toBe(1)
    await hooks["tool.execute.after"]({ tool: "task", callID: "dup" })
    expect(getInFlight()).toBe(0)
  })
})

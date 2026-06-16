import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin, {
  __testing__,
  parseSerialCommand,
  parseDuration,
  formatDuration,
} from "../index.ts"

const {
  reset,
  getConcurrency,
  getTimeoutMs,
  getStateFile,
  setStateFile,
  getConfigDefaults,
  applyCommand,
  loadPersisted,
} = __testing__

let tmpfile = ""

function tmp(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sss-")), "state.json")
  tmpfile = p
  return p
}

beforeEach(() => {
  reset()
})

afterEach(() => {
  if (tmpfile) {
    try {
      fs.rmSync(path.dirname(tmpfile), { recursive: true, force: true })
    } catch {
      // ignore
    }
    tmpfile = ""
  }
})

describe("parseDuration", () => {
  test("parses s/m/h/ms and bare ms", () => {
    expect(parseDuration("600s")).toBe(600_000)
    expect(parseDuration("10m")).toBe(600_000)
    expect(parseDuration("2h")).toBe(7_200_000)
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("1500")).toBe(1500) // bare = ms
    expect(parseDuration("1.5m")).toBe(90_000)
  })
  test("rejects garbage and negatives", () => {
    expect(parseDuration("abc")).toBeNull()
    expect(parseDuration("-5s")).toBeNull()
    expect(parseDuration("")).toBeNull()
    expect(parseDuration("10x")).toBeNull()
  })
})

describe("formatDuration", () => {
  test("picks the largest whole unit", () => {
    expect(formatDuration(7_200_000)).toBe("2h")
    expect(formatDuration(600_000)).toBe("10m")
    expect(formatDuration(600_000 / 6)).toBe("100s")
    expect(formatDuration(12345)).toBe("12345ms")
    expect(formatDuration(0)).toBe("0")
  })
})

describe("parseSerialCommand", () => {
  test("bare /serial -> status", () => {
    expect(parseSerialCommand("/serial")).toEqual({ kind: "status" })
    expect(parseSerialCommand("  /serial  ")).toEqual({ kind: "status" })
  })
  test("/serial reset -> reset", () => {
    expect(parseSerialCommand("/serial reset")).toEqual({ kind: "reset" })
  })
  test("set both -n and -t", () => {
    expect(parseSerialCommand("/serial -n 3 -t 10m")).toEqual({
      kind: "set",
      concurrency: 3,
      timeoutMs: 600_000,
    })
  })
  test("partial: -n only", () => {
    expect(parseSerialCommand("/serial -n 2")).toEqual({ kind: "set", concurrency: 2, timeoutMs: undefined })
  })
  test("partial: -t only", () => {
    expect(parseSerialCommand("/serial -t 5m")).toEqual({ kind: "set", concurrency: undefined, timeoutMs: 300_000 })
  })
  test("case-insensitive command name", () => {
    expect(parseSerialCommand("/SERIAL -n 2")).toEqual({ kind: "set", concurrency: 2, timeoutMs: undefined })
  })
  test("non-command text returns null (not intercepted)", () => {
    expect(parseSerialCommand("hello world")).toBeNull()
    expect(parseSerialCommand("/serialization of data")).toBeNull()
  })
  test("invalid -n value -> error", () => {
    const r = parseSerialCommand("/serial -n abc")
    expect(r).toMatchObject({ kind: "error" })
  })
  test("invalid -t value -> error", () => {
    const r = parseSerialCommand("/serial -t 10z")
    expect(r).toMatchObject({ kind: "error" })
  })
  test("unknown subcommand -> error", () => {
    const r = parseSerialCommand("/serial frobnicate")
    expect(r).toMatchObject({ kind: "error" })
  })
  test("flags can appear in either order", () => {
    expect(parseSerialCommand("/serial -t 30s -n 4")).toEqual({
      kind: "set",
      concurrency: 4,
      timeoutMs: 30_000,
    })
  })
})

describe("applyCommand", () => {
  beforeEach(() => {
    // wire up a tmp persistence file + config defaults
    setStateFile(tmp())
    __testing__.setConfigDefaults({ timeoutMs: 5 * 60_000, concurrency: 1 })
  })

  test("set -n updates concurrency", () => {
    const out = applyCommand(parseSerialCommand("/serial -n 4")!)
    expect(getConcurrency()).toBe(4)
    expect(out).toContain("concurrency=4")
  })

  test("set -t updates timeout", () => {
    applyCommand(parseSerialCommand("/serial -t 10m")!)
    expect(getTimeoutMs()).toBe(600_000)
  })

  test("partial -n leaves timeout untouched", () => {
    __testing__.setTimeoutMs(120_000)
    applyCommand(parseSerialCommand("/serial -n 2")!)
    expect(getConcurrency()).toBe(2)
    expect(getTimeoutMs()).toBe(120_000)
  })

  test("reset restores config defaults and clears the file", () => {
    applyCommand(parseSerialCommand("/serial -n 9 -t 1h")!)
    expect(getConcurrency()).toBe(9)
    applyCommand(parseSerialCommand("/serial reset")!)
    expect(getConcurrency()).toBe(1)
    expect(getTimeoutMs()).toBe(5 * 60_000)
    expect(loadPersisted(getStateFile())).toEqual({})
  })

  test("status echoes current values", () => {
    __testing__.setConcurrency(2)
    __testing__.setTimeoutMs(600_000)
    const out = applyCommand({ kind: "status" })
    expect(out).toBe("[serial] concurrency=2 timeout=10m")
  })

  test("error kind echoes a message", () => {
    const out = applyCommand({ kind: "error", message: "boom" })
    expect(out).toBe("[serial] boom")
  })
})

describe("persistence", () => {
  test("set writes a merged file (partial updates preserve the other key)", () => {
    setStateFile(tmp())
    __testing__.setConfigDefaults({ timeoutMs: 5 * 60_000, concurrency: 1 })
    applyCommand(parseSerialCommand("/serial -n 2")!)
    expect(loadPersisted(getStateFile())).toEqual({ concurrency: 2 })
    applyCommand(parseSerialCommand("/serial -t 10m")!)
    expect(loadPersisted(getStateFile())).toEqual({ concurrency: 2, timeoutMs: 600_000 })
  })

  test("factory init loads persisted overrides on top of config defaults", async () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify({ concurrency: 3, timeoutMs: 42_000 }), "utf8")
    await plugin({} as Parameters<typeof plugin>[0], { stateFile: file, timeoutMs: 1000, concurrency: 1 })
    // persisted overrides config
    expect(getConcurrency()).toBe(3)
    expect(getTimeoutMs()).toBe(42_000)
    expect(getConfigDefaults()).toEqual({ timeoutMs: 1000, concurrency: 1 }) // config defaults untouched
  })

  test("reset clears persisted file", () => {
    const file = tmp()
    setStateFile(file)
    fs.writeFileSync(file, JSON.stringify({ concurrency: 5 }), "utf8")
    applyCommand(parseSerialCommand("/serial reset")!)
    expect(fs.readFileSync(file, "utf8").trim()).toBe("{}")
  })

  test("stateFile null disables persistence (no file touched)", async () => {
    await plugin({} as Parameters<typeof plugin>[0], { stateFile: null, concurrency: 2 })
    expect(getStateFile()).toBe("")
    applyCommand(parseSerialCommand("/serial -n 7")!)
    // no throw, nothing to read
    expect(getConcurrency()).toBe(7)
  })
})

describe("chat.message hook", () => {
  type TextPart = { type: "text"; text: string; ignored?: boolean }

  async function runHook(parts: TextPart[]): Promise<TextPart[]> {
    // hook list includes chat.message among the tool hooks
    type Hooks = {
      "chat.message": (input: unknown, output: { parts: TextPart[] }) => Promise<void>
    }
    const hooks = (await plugin({} as Parameters<typeof plugin>[0], {
      stateFile: null,
      concurrency: 1,
    })) as unknown as Hooks
    await hooks["chat.message"]({} as never, { parts })
    return parts
  }

  test("intercepts /serial -n 2: marks ignored + echoes, updates state", async () => {
    const parts = [{ type: "text", text: "/serial -n 2 -t 5m" } as TextPart]
    await runHook(parts)
    expect(parts[0]?.ignored).toBe(true)
    expect(parts[0]?.text).toBe("[serial] concurrency=2 timeout=5m")
    expect(getConcurrency()).toBe(2)
    expect(getTimeoutMs()).toBe(300_000)
  })

  test("non-command message is passed through untouched", async () => {
    const parts = [{ type: "text", text: "fix the bug" } as TextPart]
    await runHook(parts)
    expect(parts[0]?.ignored).toBeUndefined()
    expect(parts[0]?.text).toBe("fix the bug")
  })

  test("bare /serial returns status", async () => {
    const parts = [{ type: "text", text: "/serial" } as TextPart]
    await runHook(parts)
    expect(parts[0]?.ignored).toBe(true)
    expect(parts[0]?.text).toMatch(/^\[serial\] concurrency=\d+ timeout=/)
  })
})

describe("drain on concurrency increase", () => {
  test("raising concurrency while waiters exist releases them", async () => {
    // start serial, fill the slot, queue two waiters, then raise to 3
    __testing__.setConcurrency(1)
    const order: string[] = []
    void __testing__.acquire().then(() => order.push("A"))
    const b = __testing__.acquire().then(() => order.push("B"))
    const c = __testing__.acquire().then(() => order.push("C"))
    expect(__testing__.getWaiters().length).toBe(2)
    // applyCommand set -n 3 should drain waiters up to the new cap
    setStateFile("")
    applyCommand(parseSerialCommand("/serial -n 3")!)
    await Promise.all([b, c])
    expect(order).toEqual(["A", "B", "C"])
    expect(__testing__.getInFlight()).toBe(3)
  })
})

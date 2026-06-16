# opencode-serial-subagents

Opencode plugin that serializes parallel subagent `task` calls into a FIFO queue with a configurable timeout.

## The problem

When an opencode agent emits multiple `task` tool calls in a single model response, the AI SDK runs them in parallel via `Promise.all`. That's fine for some workflows, but if your subagents share state (files, a dev server, an in-memory store, a database transaction), the second subagent often sees a half-written world and clobbers the first one's output.

This plugin forces strict FIFO execution with a single concurrency slot by default, and includes a timeout fallback so a single cancel or stuck call can't permanently wedge the queue.

## Install

### Option 1: Drop-in file (no build, no deps)

opencode auto-loads any `.js`/`.ts` file found in `~/.config/opencode/plugins/` (global) or `.opencode/plugins/` (project) at startup, and bun imports `.ts` directly — so you can copy `index.ts` straight in (its only import is type-only and erased at runtime):

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL -o ~/.config/opencode/plugins/serial-subagents.ts \
  https://raw.githubusercontent.com/Jaylonnet/serial-subagents/main/index.ts
```

Restart opencode and it's active. This uses the default options (`timeoutMs` 5 min, `concurrency` 1). To pass custom options, use Option 2.

### Option 2: Package install (version-managed, supports options)

Add a `package.json` in your opencode config dir pointing at the GitHub repo:

```json
{ "dependencies": { "opencode-serial-subagents": "github:Jaylonnet/serial-subagents" } }
```

Then reference it (with options) in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    ["opencode-serial-subagents", { "timeoutMs": 600000, "concurrency": 1 }]
  ]
}
```

opencode runs `bun install` on the config-dir `package.json`; the committed `dist/` provides the compiled entry point, so no build step is needed on your machine. For a project-scoped install, use `.opencode/` instead of `~/.config/opencode/`.

## Config

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `timeoutMs` | number | `300000` (5 min) | Max time a `task` call may hold its slot. On expiry, the slot is force-released and the queue proceeds. Set to `0` to fall back to a microtask release. |
| `concurrency` | number | `1` | Max parallel `task` calls. `1` = fully serial. Values `<= 0` are clamped to `1`. |

Both options are clamped defensively. `NaN`, negative numbers, and non-numeric values fall back to the defaults.

## How it works

Two (sometimes three) hook handlers. `tool.execute.before` acquires a semaphore slot (FIFO when full). The `task` tool runs. `tool.execute.after` (or `tool.execute.error`, or the `timeoutMs` safety net) releases the slot.

State lives in a `Map<callID, PerCall>` keyed by opencode's stable per-call ULID. There is no `output.args` mutation, no global promise chain, and no per-call state that survives a cancel. See [Limitations](#limitations) for why.

A timeout is scheduled in `tool.execute.before` for every call. The timer is `.unref()`'d so it doesn't keep the event loop alive on its own, and it calls the same `releaseForCall` path that `tool.execute.after` and `tool.execute.error` use — so a single code path is responsible for cleanup.

## Limitations

- **No `output.args` mutation.** Mutations to `output.args` in `tool.execute.before` are silently ignored. The trigger creates a fresh inline `{ args }` object each call, and the actual tool execution uses the closure-captured `args` variable — not the mutated `output.args`. See opencode issues [#31680](https://github.com/anomalyco/opencode/issues/31680) (dup: [#20013](https://github.com/anomalyco/opencode/issues/20013), [#26910](https://github.com/anomalyco/opencode/issues/26910)).
- **On opencode ≥ 1.14, `output.args` is frozen.** With `OPENCODE_EXPERIMENTAL=true`, the args tree is passed through Immer's `produce()`, which calls `Object.freeze()`. Any mutation throws `TypeError: Attempted to assign to readonly property`. The canonical reproducer (with 8 known crash sites in another plugin) is tracked at [code-yeongyu/oh-my-openagent#3816](https://github.com/code-yeongyu/oh-my-openagent/issues/3816). We use `input.callID` as the per-call key, which is set by opencode itself and is stable.
- **On user-cancel, `tool.execute.after` is not fired.** In `session/processor.ts:cleanup()`, in-flight tool parts are marked as `interrupted: true` and assigned `error: "Tool execution aborted"`, but the after-hook is bypassed. The `timeoutMs` fallback handles this. If you set `timeoutMs: 0`, a cancel will still unblock the next call via a microtask, but the predecessor's slot disappears without a clean release — expect occasional oddities at `concurrency > 1`.
- **Only the `task` tool is targeted.** Custom tool names are not yet supported. PRs welcome.

## Development

```bash
bun install        # install dev deps
bun test           # run the queue + timeout tests
bun run typecheck  # tsc --noEmit
bun run build      # emit dist/index.js + dist/index.d.ts
```

### The `__testing__` export

The bottom of `index.ts` exports an `__testing__` object with `acquire`, `release`, `releaseForCall`, `perCall`, `getInFlight`, `setInFlight`, `getWaiters`, `setConcurrency`, `reset`, and `clampOptions`. This is for the test suite only — it is not part of the public API and may change without notice. Don't import it from your own code.

## Roadmap

- Custom tool names (`options.tools: string[]`)
- Metrics counters (current queue depth, total wedges, total timeouts)
- Per-tool concurrency limits
- Optional cancellation of the currently-running call (currently out of scope; we only manage queueing)

## Repo vs package name

The source repo is at [github.com/Jaylonnet/serial-subagents](https://github.com/Jaylonnet/serial-subagents). The package/import name in `package.json` is `opencode-serial-subagents` (the `opencode-` prefix is an ecosystem convention). It is **not** published to npm — install it from GitHub as shown in [Install](#install).

## License

MIT — Copyright (c) 2026 Jay. See [LICENSE](./LICENSE).

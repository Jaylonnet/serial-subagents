const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 1;
const TARGET_TOOL = "task";
const perCall = new Map();
let inFlight = 0;
let concurrency = DEFAULT_CONCURRENCY;
const waiters = [];
export function clampOptions(opts) {
    const o = (opts ?? {});
    const rawTimeout = Number(o.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
    const rawConcurrency = Number(o.concurrency);
    concurrency =
        Number.isFinite(rawConcurrency) && rawConcurrency > 0
            ? Math.max(1, Math.floor(rawConcurrency))
            : DEFAULT_CONCURRENCY;
    return { timeoutMs, concurrency };
}
export function acquire() {
    if (inFlight < concurrency) {
        inFlight++;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        waiters.push(() => {
            inFlight++;
            resolve();
        });
    });
}
export function release() {
    if (inFlight > 0)
        inFlight--;
    const next = waiters.shift();
    if (next)
        next();
}
export function releaseForCall(callId, reason) {
    const entry = perCall.get(callId);
    if (!entry)
        return;
    if (entry.finished)
        return;
    entry.finished = true;
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
    perCall.delete(callId);
    if (reason === "timeout") {
        console.warn(`[opencode-serial-subagents] ${TARGET_TOOL} call ${callId} did not complete within timeout; releasing slot to unblock queue.`);
    }
    release();
    try {
        entry.release();
    }
    catch {
        // resolver already called; safe to ignore
    }
}
export default (async (_input, opts) => {
    const { timeoutMs } = clampOptions(opts);
    const before = async (input) => {
        if (input.tool !== TARGET_TOOL)
            return;
        const callId = input.callID;
        if (!callId)
            return;
        if (perCall.has(callId)) {
            // Duplicate hook fire for the same call: the slot is already held
            // by the original entry. Do nothing.
            return;
        }
        let resolveGate;
        const gate = new Promise((r) => {
            resolveGate = r;
        });
        const entry = { release: resolveGate, finished: false, timer: null };
        perCall.set(callId, entry);
        if (timeoutMs > 0) {
            entry.timer = setTimeout(() => releaseForCall(callId, "timeout"), timeoutMs);
            if (entry.timer && typeof entry.timer.unref === "function") {
                ;
                entry.timer.unref();
            }
        }
        else {
            queueMicrotask(() => releaseForCall(callId, "timeout"));
        }
        void gate;
        await acquire();
    };
    const after = async (input) => {
        if (input.tool !== TARGET_TOOL)
            return;
        const callId = input.callID;
        if (!callId)
            return;
        releaseForCall(callId, "after");
    };
    const error = async (input) => {
        if (input.tool !== TARGET_TOOL)
            return;
        const callId = input.callID;
        if (!callId)
            return;
        releaseForCall(callId, "error");
    };
    return {
        "tool.execute.before": before,
        "tool.execute.after": after,
        "tool.execute.error": error,
    };
});
export const __testing__ = {
    acquire,
    release,
    releaseForCall,
    perCall,
    getInFlight: () => inFlight,
    setInFlight: (n) => {
        inFlight = n;
    },
    getWaiters: () => waiters,
    setConcurrency: (n) => {
        concurrency = n;
    },
    reset: () => {
        perCall.clear();
        inFlight = 0;
        waiters.length = 0;
        concurrency = DEFAULT_CONCURRENCY;
    },
    clampOptions,
};
//# sourceMappingURL=index.js.map
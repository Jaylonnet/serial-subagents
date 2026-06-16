import fs from "node:fs";
import path from "node:path";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 1;
const TARGET_TOOL = "task";
const STATE_FILENAME = "serial-subagents.json";
const perCall = new Map();
let inFlight = 0;
let concurrency = DEFAULT_CONCURRENCY;
let timeoutMs = DEFAULT_TIMEOUT_MS;
const waiters = [];
let stateFilePath = "";
let configDefaults = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
};
export function clampOptions(opts) {
    const o = (opts ?? {});
    return {
        timeoutMs: clampTimeout(o.timeoutMs),
        concurrency: clampConcurrency(o.concurrency),
    };
}
function clampTimeout(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MS;
}
function clampConcurrency(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : DEFAULT_CONCURRENCY;
}
function drain() {
    while (inFlight < concurrency && waiters.length > 0) {
        const next = waiters.shift();
        inFlight++;
        next();
    }
}
export function acquire() {
    if (inFlight < concurrency) {
        inFlight++;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        waiters.push(resolve);
    });
}
export function release() {
    if (inFlight > 0)
        inFlight--;
    drain();
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
// ---- persistence -------------------------------------------------------
function resolveDefaultStateFile() {
    const xdg = process.env.XDG_CONFIG_HOME;
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const base = xdg || (home ? path.join(home, ".config") : "");
    return base ? path.join(base, "opencode", STATE_FILENAME) : "";
}
function loadPersisted(sf) {
    if (!sf)
        return {};
    try {
        const data = JSON.parse(fs.readFileSync(sf, "utf8"));
        if (!data || typeof data !== "object")
            return {};
        const d = data;
        const out = {};
        if (typeof d.timeoutMs === "number" && Number.isFinite(d.timeoutMs) && d.timeoutMs >= 0) {
            out.timeoutMs = d.timeoutMs;
        }
        if (typeof d.concurrency === "number" && Number.isFinite(d.concurrency) && d.concurrency > 0) {
            out.concurrency = Math.max(1, Math.floor(d.concurrency));
        }
        return out;
    }
    catch {
        return {};
    }
}
function savePersisted(sf, patch) {
    if (!sf)
        return;
    const merged = { ...loadPersisted(sf), ...patch };
    try {
        fs.mkdirSync(path.dirname(sf), { recursive: true });
        fs.writeFileSync(sf, JSON.stringify(merged, null, 2) + "\n", "utf8");
    }
    catch {
        // best-effort; ignore write errors
    }
}
function clearPersisted(sf) {
    if (!sf)
        return;
    try {
        fs.writeFileSync(sf, "{}\n", "utf8");
    }
    catch {
        // best-effort
    }
}
// ---- /serial command ---------------------------------------------------
export function parseDuration(s) {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(s.trim());
    if (!m)
        return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0)
        return null;
    const unit = (m[2] ?? "ms").toLowerCase();
    const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
    return Math.round(n * mult);
}
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return "0";
    if (ms % 3_600_000 === 0)
        return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0)
        return `${ms / 60_000}m`;
    if (ms % 1000 === 0)
        return `${ms / 1000}s`;
    return `${ms}ms`;
}
export function parseSerialCommand(text) {
    const trimmed = text.trim();
    if (!/^\/serial\b/i.test(trimmed))
        return null;
    const rest = trimmed.slice("/serial".length).trim();
    if (rest === "")
        return { kind: "status" };
    if (/^reset\b/i.test(rest))
        return { kind: "reset" };
    let concurrency;
    let timeoutMs;
    let matched = 0;
    const flagRe = /-([nt])\s+(\S+)/gi;
    let mm;
    while ((mm = flagRe.exec(rest)) !== null) {
        matched++;
        const flag = (mm[1] ?? "").toLowerCase();
        const val = mm[2] ?? "";
        if (flag === "n") {
            const n = Math.trunc(Number(val));
            if (!Number.isFinite(n) || n < 1) {
                return { kind: "error", message: `invalid concurrency '-n ${val}' (expected a positive integer)` };
            }
            concurrency = n;
        }
        else {
            const ms = parseDuration(val);
            if (ms === null) {
                return { kind: "error", message: `invalid timeout '-t ${val}' (examples: 600s, 10m, 2h, or bare ms)` };
            }
            timeoutMs = ms;
        }
    }
    if (matched === 0) {
        return { kind: "error", message: `unknown arguments '${rest}' (expected -n <int>, -t <duration>, or reset)` };
    }
    return { kind: "set", concurrency, timeoutMs };
}
export function applyCommand(cmd) {
    switch (cmd.kind) {
        case "status":
            return `[serial] concurrency=${concurrency} timeout=${formatDuration(timeoutMs)}`;
        case "reset": {
            concurrency = configDefaults.concurrency;
            timeoutMs = configDefaults.timeoutMs;
            clearPersisted(stateFilePath);
            drain();
            return `[serial] reset to defaults: concurrency=${concurrency} timeout=${formatDuration(timeoutMs)}`;
        }
        case "set": {
            const patch = {};
            if (cmd.concurrency !== undefined) {
                concurrency = clampConcurrency(cmd.concurrency);
                patch.concurrency = concurrency;
                drain();
            }
            if (cmd.timeoutMs !== undefined) {
                timeoutMs = clampTimeout(cmd.timeoutMs);
                patch.timeoutMs = timeoutMs;
            }
            savePersisted(stateFilePath, patch);
            return `[serial] concurrency=${concurrency} timeout=${formatDuration(timeoutMs)}`;
        }
        case "error":
            return `[serial] ${cmd.message}`;
    }
}
// ---- plugin ------------------------------------------------------------
export default (async (_input, opts) => {
    const o = (opts ?? {});
    configDefaults = clampOptions(o);
    stateFilePath =
        o.stateFile === undefined ? resolveDefaultStateFile() : o.stateFile === null ? "" : String(o.stateFile);
    const persisted = loadPersisted(stateFilePath);
    const effective = clampOptions({ ...configDefaults, ...persisted });
    concurrency = effective.concurrency;
    timeoutMs = effective.timeoutMs;
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
        "chat.message": async (_input, output) => {
            for (const part of output.parts) {
                if (part.type === "text") {
                    const cmd = parseSerialCommand(part.text);
                    if (cmd) {
                        part.text = applyCommand(cmd);
                        part.ignored = true;
                    }
                }
            }
        },
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
    getConcurrency: () => concurrency,
    setConcurrency: (n) => {
        concurrency = clampConcurrency(n);
    },
    getTimeoutMs: () => timeoutMs,
    setTimeoutMs: (n) => {
        timeoutMs = clampTimeout(n);
    },
    getStateFile: () => stateFilePath,
    setStateFile: (p) => {
        stateFilePath = p ?? "";
    },
    getConfigDefaults: () => configDefaults,
    setConfigDefaults: (d) => {
        configDefaults = d;
    },
    reset: () => {
        perCall.clear();
        inFlight = 0;
        waiters.length = 0;
        concurrency = DEFAULT_CONCURRENCY;
        timeoutMs = DEFAULT_TIMEOUT_MS;
        stateFilePath = "";
        configDefaults = { timeoutMs: DEFAULT_TIMEOUT_MS, concurrency: DEFAULT_CONCURRENCY };
    },
    clampOptions,
    parseSerialCommand,
    applyCommand,
    parseDuration,
    formatDuration,
    resolveDefaultStateFile,
    loadPersisted,
    savePersisted,
    clearPersisted,
};
//# sourceMappingURL=index.js.map
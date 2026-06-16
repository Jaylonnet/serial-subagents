export interface Options {
    /**
     * Maximum time (ms) a `task` call may hold its slot before the
     * queue force-proceeds to the next call. Default 5 minutes.
     *
     * Acts as a safety net for the case where `tool.execute.after`
     * is never fired by opencode (e.g. user-cancel, internal error).
     * Set to 0 to fall back to a microtask release on the next tick.
     */
    timeoutMs?: number;
    /**
     * Maximum number of `task` calls running in parallel. Default 1
     * (fully serial). Values <= 0 are clamped to 1.
     */
    concurrency?: number;
    /**
     * Path to the JSON file that persists runtime overrides set via the
     * `/serial` command. Defaults to `<config>/opencode/serial-subagents.json`.
     * Pass `null` to disable persistence entirely.
     */
    stateFile?: string | null;
}
export type ResolvedOptions = Required<Pick<Options, "timeoutMs" | "concurrency">>;
interface PerCall {
    release: () => void;
    finished: boolean;
    timer: ReturnType<typeof setTimeout> | null;
}
export declare function clampOptions(opts: unknown): ResolvedOptions;
export declare function acquire(): Promise<void>;
export declare function release(): void;
export declare function releaseForCall(callId: string, reason: "after" | "timeout" | "error"): void;
declare function resolveDefaultStateFile(): string;
declare function loadPersisted(sf: string): Partial<ResolvedOptions>;
declare function savePersisted(sf: string, patch: Partial<ResolvedOptions>): void;
declare function clearPersisted(sf: string): void;
export declare function parseDuration(s: string): number | null;
export declare function formatDuration(ms: number): string;
export type SerialCommand = {
    kind: "status";
} | {
    kind: "reset";
} | {
    kind: "set";
    concurrency?: number;
    timeoutMs?: number;
} | {
    kind: "error";
    message: string;
};
export declare function parseSerialCommand(text: string): SerialCommand | null;
export declare function applyCommand(cmd: SerialCommand): string;
declare const _default: (_input: import("@opencode-ai/plugin").PluginInput, opts: import("@opencode-ai/plugin").PluginOptions | undefined) => Promise<{
    "tool.execute.before": (input: {
        tool: string;
        callID: string;
    }) => Promise<void>;
    "tool.execute.after": (input: {
        tool: string;
        callID: string;
    }) => Promise<void>;
    "tool.execute.error": (input: {
        tool: string;
        callID: string;
    }) => Promise<void>;
    "chat.message": (_input: {
        sessionID: string;
        agent?: string;
        model?: {
            providerID: string;
            modelID: string;
        };
        messageID?: string;
        variant?: string;
    }, output: {
        message: import("@opencode-ai/sdk").UserMessage;
        parts: import("@opencode-ai/sdk").Part[];
    }) => Promise<void>;
}>;
export default _default;
export declare const __testing__: {
    acquire: typeof acquire;
    release: typeof release;
    releaseForCall: typeof releaseForCall;
    perCall: Map<string, PerCall>;
    getInFlight: () => number;
    setInFlight: (n: number) => void;
    getWaiters: () => (() => void)[];
    getConcurrency: () => number;
    setConcurrency: (n: number) => void;
    getTimeoutMs: () => number;
    setTimeoutMs: (n: number) => void;
    getStateFile: () => string;
    setStateFile: (p: string | null) => void;
    getConfigDefaults: () => Required<Pick<Options, "timeoutMs" | "concurrency">>;
    setConfigDefaults: (d: ResolvedOptions) => void;
    reset: () => void;
    clampOptions: typeof clampOptions;
    parseSerialCommand: typeof parseSerialCommand;
    applyCommand: typeof applyCommand;
    parseDuration: typeof parseDuration;
    formatDuration: typeof formatDuration;
    resolveDefaultStateFile: typeof resolveDefaultStateFile;
    loadPersisted: typeof loadPersisted;
    savePersisted: typeof savePersisted;
    clearPersisted: typeof clearPersisted;
};
//# sourceMappingURL=index.d.ts.map
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
}
interface PerCall {
    release: () => void;
    finished: boolean;
    timer: ReturnType<typeof setTimeout> | null;
}
export declare function clampOptions(opts: unknown): Required<Options>;
export declare function acquire(): Promise<void>;
export declare function release(): void;
export declare function releaseForCall(callId: string, reason: "after" | "timeout" | "error"): void;
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
    setConcurrency: (n: number) => void;
    reset: () => void;
    clampOptions: typeof clampOptions;
};
//# sourceMappingURL=index.d.ts.map
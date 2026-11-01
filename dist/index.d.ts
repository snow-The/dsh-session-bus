export declare const name = "session-bus";
export declare const inject: string[];
type Json = null | boolean | number | string | Json[] | {
    [k: string]: Json | undefined;
};
interface Tool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, Json>;
        required?: string[];
    };
    output: {
        schema: Json;
        render: (args: Json, value: Json) => {
            type: 'text';
            text: string;
        }[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: () => boolean;
    execute: (args: Json, exec: unknown) => Promise<Json>;
}
interface Ctx {
    tools: {
        register: (tool: Tool) => void;
    };
    /** Inject-free official service read; a direct property read throws without `inject`. */
    get?: (name: string) => unknown;
    /** Register a callback against a child scope that HAS the named services. */
    inject?: (deps: string[], callback: (scope: unknown) => unknown) => unknown;
    effect?: (fn: () => void) => unknown;
    on?: (event: 'dispose', fn: () => void) => unknown;
}
/** Configuration is optional everywhere: defaults are the live-host layout. */
export interface BusOptions {
    /** Overrides `$DSH_HOME` and `~/.dsh`. */
    dshHome?: string;
    /** Overrides the port file entirely, e.g. `http://127.0.0.1:7331`. */
    baseUrl?: string;
    /** Refresh interval for the registry/wake tick. Tests use it to avoid waiting a minute. */
    heartbeatMs?: number;
    /** Overrides `<bus home>/token`. */
    tokenFile?: string;
    timeoutMs?: number;
}
export declare function apply(ctx: Ctx, options?: BusOptions): void;
export {};

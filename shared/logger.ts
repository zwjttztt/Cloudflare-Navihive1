/// <reference types="vite/client" />

/** Structured context is passed through without serializing errors or other values. */
export interface LogFields {
    component?: string;
    action?: string;
    rid?: string;
    [key: string]: unknown;
}

type LogLevel = "debug" | "info" | "warn" | "error";

/** Logging must never interrupt a request, including when console is unavailable. */
function emit(level: LogLevel, message: string, fields?: LogFields): void {
    try {
        console[level](message, ...(fields === undefined ? [] : [fields]));
    } catch {
        // Console getters and implementations can throw in embedded hosts and tests.
    }
}

// Vite replaces this property with a literal; the standalone esbuild server does
// not inject it. An unknown build environment therefore defaults to warn/error.
// Keeping the condition at each method lets production builds remove emit calls.
export const logger = {
    debug(message: string, fields?: LogFields): void {
        try {
            if (import.meta.env?.PROD === false) emit("debug", message, fields);
        } catch { /* Environment access must not break a request. */ }
    },
    info(message: string, fields?: LogFields): void {
        try {
            if (import.meta.env?.PROD === false) emit("info", message, fields);
        } catch { /* Environment access must not break a request. */ }
    },
    warn: (message: string, fields?: LogFields): void => emit("warn", message, fields),
    error: (message: string, fields?: LogFields): void => emit("error", message, fields),
};

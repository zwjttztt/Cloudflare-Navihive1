import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import type { TransformOptions, TransformResult } from "esbuild";
import type { logger as actualLogger } from "../shared/logger";

type Logger = typeof actualLogger;
type Level = "debug" | "info" | "warn" | "error";
interface Emission {
    level: Level;
    args: unknown[];
}
interface CompiledLogger {
    logger: Logger;
}

// Load the real source and transform it as a build would. The console lives in an
// isolated VM so these tests never replace the test runner's global console.
const root: string = process.cwd();
const requireFromRoot = createRequire(path.join(root, "package.json"));
const esbuild = requireFromRoot("esbuild") as {
    transformSync(source: string, options: TransformOptions): TransformResult;
};
const source: string = readFileSync(path.join(root, "shared/logger.ts"), "utf8");

function loadLogger(prod: boolean | undefined, consoleValue: unknown): Logger {
    const result: TransformResult = esbuild.transformSync(source, {
        loader: "ts",
        format: "iife",
        globalName: "loggerModule",
        target: "es2022",
        minify: true,
        logLevel: "silent",
        ...(prod === undefined ? {} : { define: { "import.meta.env.PROD": String(prod) } }),
    });
    const module = runInNewContext(`${result.code}\nloggerModule;`, {
        console: consoleValue,
    }) as CompiledLogger;
    return module.logger;
}

function recordingConsole(emissions: Emission[]): Record<Level, (...args: unknown[]) => void> {
    return {
        debug: (...args: unknown[]): void => { emissions.push({ level: "debug", args }); },
        info: (...args: unknown[]): void => { emissions.push({ level: "info", args }); },
        warn: (...args: unknown[]): void => { emissions.push({ level: "warn", args }); },
        error: (...args: unknown[]): void => { emissions.push({ level: "error", args }); },
    };
}

function logAll(logger: Logger): void {
    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");
}

test("logger: production build filters debug/info and preserves warn/error channels", () => {
    const emissions: Emission[] = [];
    logAll(loadLogger(true, recordingConsole(emissions)));
    assert.deepEqual(emissions.map(entry => entry.level), ["warn", "error"]);
    assert.deepEqual(emissions.map(entry => entry.args[0]), ["warn message", "error message"]);
});

test("logger: development build emits all four levels to their matching channels", () => {
    const emissions: Emission[] = [];
    logAll(loadLogger(false, recordingConsole(emissions)));
    assert.deepEqual(emissions.map(entry => entry.level), ["debug", "info", "warn", "error"]);
});

test("logger: a build without env injection defaults to warn/error", () => {
    const emissions: Emission[] = [];
    logAll(loadLogger(undefined, recordingConsole(emissions)));
    assert.deepEqual(emissions.map(entry => entry.level), ["warn", "error"]);
});

test("logger: structured context and the original Error retain their references", () => {
    const emissions: Emission[] = [];
    const error: Error = new Error("original failure");
    const fields = { component: "transfer", action: "importData", rid: "request-7", err: error };
    const logger: Logger = loadLogger(true, recordingConsole(emissions));
    logger.error("import failed", fields);
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].args[1], fields);
    assert.equal((emissions[0].args[1] as typeof fields).err, error);
    assert.equal(error.message, "original failure");
});

test("logger: throwing console implementations cannot interrupt requests", () => {
    const fail = (): never => { throw new Error("console unavailable"); };
    const logger: Logger = loadLogger(false, { debug: fail, info: fail, warn: fail, error: fail });
    assert.doesNotThrow(() => logAll(logger));
});

test("logger: throwing console getters and an absent console cannot interrupt requests", () => {
    const consoleValue: object = Object.defineProperties({}, {
        debug: { get(): never { throw new Error("debug getter"); } },
        info: { get(): never { throw new Error("info getter"); } },
        warn: { get(): never { throw new Error("warn getter"); } },
        error: { get(): never { throw new Error("error getter"); } },
    });
    assert.doesNotThrow(() => logAll(loadLogger(false, consoleValue)));
    assert.doesNotThrow(() => logAll(loadLogger(false, undefined)));
});

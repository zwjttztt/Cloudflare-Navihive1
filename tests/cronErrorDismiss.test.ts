// tests/cronErrorDismiss.test.ts
// 「忽略一周」的本地偏好（src/utils/cronErrorDismiss.ts）。
// 关键边界：过期失效、message 变了不认、坏 JSON / 无 localStorage 不炸。

import test from "node:test";
import assert from "node:assert/strict";
import { cronErrorDismissed, dismissCronError } from "../src/utils/cronErrorDismiss";

const MSG = "每周自动备份失败：账号 1：The operation was aborted due to timeout";

/** 一次性内存版 localStorage（jsdom 无布局但这里连 jsdom 都不用，直接换全局） */
function withStorage(run: () => void, store: Record<string, string> = {}): void {
    const fake = {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
            store[k] = v;
        },
    };
    const real = globalThis.localStorage;
    // 测试环境（node）本就没有 localStorage，直接挂；有则替换
    Object.defineProperty(globalThis, "localStorage", {
        value: fake,
        configurable: true,
        writable: true,
    });
    try {
        run();
    } finally {
        if (real === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
        else Object.defineProperty(globalThis, "localStorage", { value: real, configurable: true, writable: true });
    }
}

test("忽略后生效，一周内不再提示", () => {
    withStorage(() => {
        assert.equal(cronErrorDismissed(MSG), false);
        dismissCronError(MSG, 1_000_000);
        // 一周内（7*24h - 1ms）都算忽略期
        assert.equal(cronErrorDismissed(MSG, 1_000_000 + 7 * 24 * 3600_000 - 1), true);
    });
});

test("过期后恢复提示", () => {
    withStorage(() => {
        dismissCronError(MSG, 1_000_000);
        assert.equal(cronErrorDismissed(MSG, 1_000_000 + 7 * 24 * 3600_000), false);
    });
});

test("新的失败消息（message 变了）不受旧忽略影响", () => {
    withStorage(() => {
        dismissCronError(MSG, 1_000_000);
        assert.equal(cronErrorDismissed("每周自动备份失败：换了别的错", 1_000_001), false);
    });
});

test("坏 JSON / 缺字段：当没忽略过，不炸", () => {
    withStorage(
        () => {
            assert.equal(cronErrorDismissed(MSG), false);
        },
        { "cron.lastError.dismissed": "{not json" }
    );
    withStorage(
        () => {
            assert.equal(cronErrorDismissed(MSG), false);
        },
        { "cron.lastError.dismissed": JSON.stringify({ message: MSG }) }
    );
    withStorage(
        () => {
            assert.equal(cronErrorDismissed(MSG), false);
        },
        { "cron.lastError.dismissed": JSON.stringify({ message: MSG, until: "不是数字" }) }
    );
});

test("localStorage 不可用（抛异常）：不炸，退化成「没忽略过 / 写不进去」", () => {
    Object.defineProperty(globalThis, "localStorage", {
        get() {
            throw new Error("SecurityError");
        },
        configurable: true,
    });
    try {
        assert.equal(cronErrorDismissed(MSG), false);
        assert.doesNotThrow(() => dismissCronError(MSG));
    } finally {
        delete (globalThis as { localStorage?: unknown }).localStorage;
    }
});

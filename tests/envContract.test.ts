// tests/envContract.test.ts
// 自托管环境变量投递清单（shared/env.ts 的 PASSTHROUGH_KEYS / EXPLICIT_ENV_KEYS）的守卫。
//
// 为什么要专门守这个：清单漏一个键的后果是**静默失效** —— 自托管那边照文档设了变量，
// worker 里读到的永远是 undefined，既不报错也不打日志。ALLOW_PLAINTEXT_SECRETS
// 就这么漏了一整轮（navigationApi.ts:221 一直在读，server/entry.ts 的白名单里没有）。
// 编译期那一半（shared/env.ts 末尾的 PassthroughComplete / PassthroughKeysExist）
// 由 `tsc -b` 负责；这里守的是类型系统看不见的三件事：
//   1. 关键键确实在清单里（断言会红，但这里给出「是谁漏了」的可读报错）；
//   2. 清单里没有绑定名（把 DB / FILES 塞进去会让入口把绑定覆盖成字符串）；
//   3. 入口**不能**再自己写一份清单（两份定义是这次事故的根因）。
//
// ⚠️ 不要 import server/entry.ts：它是可执行的 Node 入口，import 会真的建库、起 HTTP 服务。
// 想知道它有没有偷偷定义清单，只能读源码文本。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EXPLICIT_ENV_KEYS, PASSTHROUGH_KEYS } from "../shared/env";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身（与 q3StrictIsolation 同一套路） */
function projectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const passthrough: readonly string[] = PASSTHROUGH_KEYS;
const explicit: readonly string[] = EXPLICIT_ENV_KEYS;

test("关键配置键必须在自托管投递清单里（漏一个＝设了不生效、还不报错）", () => {
    // 这四个是「设了就等于换行为」的键，任何一个漏掉都很难在界面上看出来：
    //   ALLOW_PLAINTEXT_SECRETS       —— 明文落库的显式 opt-in（本轮修的 bug）
    //   AUTH_SECRET                   —— 不投递则令牌签发直接 fail-closed，登录必然失败
    //   NAVIHIVE_TRUST_X_REAL_IP      —— 漏了则反代覆盖的 X-Real-IP 不被采信
    //   NAVIHIVE_TRUST_XFF            —— 漏了则登录限速退回全场共用一个 unknown 桶
    for (const key of [
        "ALLOW_PLAINTEXT_SECRETS",
        "AUTH_SECRET",
        "NAVIHIVE_TRUST_X_REAL_IP",
        "NAVIHIVE_TRUST_XFF",
    ]) {
        assert.ok(
            passthrough.includes(key) || explicit.includes(key),
            `${key} 既不在 PASSTHROUGH_KEYS 也不在 EXPLICIT_ENV_KEYS —— 自托管设了它不会有任何效果`
        );
    }
});

test("投递清单里不许出现绑定名（那会把 D1 / R2 覆盖成字符串）", () => {
    // 绑定由入口自己装配（DB: db、FILES_KV: kv），清单只负责环境变量。
    // 一旦有人把 "DB" 当成「要不要透传」的开关塞进来，entry.ts 的
    // `passthrough` 展开在 serverEnv 最后，就会用 process.env.DB 把真绑定盖掉。
    const BINDINGS = ["DB", "FILES", "FILES_KV", "ASSETS"];
    for (const key of [...passthrough, ...explicit]) {
        assert.ok(
            !BINDINGS.includes(key),
            `${key} 是平台绑定，不是环境变量：它必须由入口装配，不能走透传清单`
        );
    }
});

test("两份清单各自无重复、彼此不重叠（重复项会让「谁是唯一投递方」说不清）", () => {
    const dupIn = (list: readonly string[], name: string) => {
        const seen = new Set<string>();
        for (const key of list) {
            assert.ok(!seen.has(key), `${name} 里 ${key} 出现了两次`);
            seen.add(key);
        }
        return seen;
    };
    const p = dupIn(passthrough, "PASSTHROUGH_KEYS");
    const e = dupIn(explicit, "EXPLICIT_ENV_KEYS");
    for (const key of e) {
        assert.ok(!p.has(key), `${key} 同时出现在两份清单里：一处照搬、一处显式赋值，谁生效取决于代码顺序`);
    }
});

test("server/entry.ts 不再自己定义 PASSTHROUGH_KEYS（两份定义必然分叉）", () => {
    const src = readFileSync(resolve(projectDir(), "server", "entry.ts"), "utf8");
    assert.ok(
        !/const\s+PASSTHROUGH_KEYS\s*=/.test(src),
        "server/entry.ts 又自己定义了一份白名单：请改成从 ../shared/env 导入 —— " +
            "两份定义正是 ALLOW_PLAINTEXT_SECRETS 静默失效的根因"
    );
    // 只删掉本地定义、忘了导入，tsc 会红；但「从别处导入」（比如又建一个 worker 侧的副本）
    // 类型上完全合法，所以这里连导入来源一起钉住。
    assert.ok(
        /import\s*\{[^}]*\bPASSTHROUGH_KEYS\b[^}]*\}\s*from\s*["']\.\.\/shared\/env["']/.test(src),
        "server/entry.ts 的 PASSTHROUGH_KEYS 必须来自 ../shared/env"
    );
});

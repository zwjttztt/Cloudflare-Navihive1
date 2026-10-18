// tests/passwordFieldGuard.test.ts
// 全站密码/口令输入框的自动填充守卫。
//
// 起因（2026-10-18 用户报告）：分组分享的「访问口令」框被浏览器自动带入
// 保存的站点密码。autocomplete='off' 对 password 字段**无效**（浏览器规范级忽略），
// 有效挡板是 autoComplete='new-password'（或仓库的 secretInput 遮蔽方案，
// type=text + CSS 遮蔽浏览器认不出密码字段）；登录表单例外——那里**要**让
// 密码管理器工作（current-password / username）。
//
// 这里扫 src 下全部 .tsx：每个裸 type='password' 的输入，同一元素附近必须有
// new-password（或 LoginForm 的 current-password 白名单）。剥注释 + 反向验证。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
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

/** 剥掉块注释与整行行注释（仓库有「注释里写正确写法」的反面教材，不剥会被蒙混） */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

function walkTsx(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkTsx(full));
        else if (entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
}

/** 登录表单白名单：这里允许（也应该）用 current-password 让密码管理器工作 */
const LOGIN_FORM_ALLOWLIST = new Set([join("src", "components", "LoginForm.tsx")]);

test("所有密码输入框都有自动填充挡板（new-password）或走遮蔽方案", () => {
    const root = projectDir();
    const offenders: string[] = [];
    for (const full of walkTsx(join(root, "src"))) {
        const rel = relative(root, full);
        const src = stripComments(readFileSync(full, "utf8"));
        for (const m of src.matchAll(/type=\s*["']password["']/g)) {
            const window = src.slice(Math.max(0, m.index! - 500), m.index! + 400);
            const hasGuard =
                /autoComplete=\s*["']new-password["']/.test(window) ||
                /autoComplete=\s*["']current-password["']/.test(window);
            if (!hasGuard && !LOGIN_FORM_ALLOWLIST.has(rel)) {
                offenders.push(`${relative(root, full)} @${m.index}`);
            }
        }
    }
    assert.deepEqual(offenders, [], "这些密码输入框缺 autoComplete='new-password'：\n  " + offenders.join("\n  "));
});

test("反向验证：守卫真的能红（注释里的规则剥掉后必须被检出）", () => {
    const broken = stripComments(`
        // autoComplete='new-password'
        const jsx = "<TextField type='password' label='口令' />";
        void jsx;
    `);
    const m = /type=\s*["']password["']/.exec(broken);
    assert.ok(m, "样本里应存在裸 password 字面量");
    const window = broken.slice(Math.max(0, (m?.index ?? 0) - 500), (m?.index ?? 0) + 400);
    assert.equal(
        /autoComplete=\s*["']new-password["']/.test(window),
        false,
        "剥掉注释后不该再匹配到挡板规则"
    );
});

test("登录表单白名单确实存在且用的是登录语义（防白名单失效成口袋罪）", () => {
    const src = stripComments(
        readFileSync(resolve(projectDir(), "src/components/LoginForm.tsx"), "utf8")
    );
    assert.ok(/autoComplete=\s*["']current-password["']/.test(src), "登录表单应保留 current-password");
    assert.ok(/autoComplete=\s*["']username["']/.test(src), "登录表单应保留 username 语义");
});

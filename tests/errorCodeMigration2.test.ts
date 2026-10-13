// tests/errorCodeMigration2.test.ts
// 错误码迁移**第二批**的守卫：worker/ 下不许再冒出 `Response.json({ success: false, ... })`
// 这种旧的失败出口。
//
// 第一批（tests/errorCodeMigration.test.ts）盯的是 `Response.json({ error: ... })`。
// 这一批盯的是另一副老面孔：`{ success: false, message }`。它比第一种更隐蔽 ——
// 看起来像个正常响应体，只是 success 是假的，客户端只能把 message 显示出来，
// 照样拿不到机器可读的 code。
//
// 2026-10-13 清点的结果：worker/ 下一共 **98** 处 `{ success: false }`，但不是全都该迁：
//   - 26 处根本不是 HTTP 出口，是**内部辅助函数的返回值**（webdav/index.ts 22 处、
//     notesBackup.ts 2 处）或 SSE/进度载荷，迁了反而破坏调用方的 `.success` 判断；
//   - 4 处是**结果对象**而非错误：ai.ts 那处带 done/total 是「部分成功」，
//     backup.ts 那 3 处是 HTTP 200 + `{ success:false }`（webdav/notes 的
//     list/download，调用方查 `.success` / `.code` 分流），迁成 4xx 会改状态码；
//   - 剩下 **70 处**是真正的失败出口，已全部迁到 ApiError + errorResponse。
//
// 所以这里的口径不是「一处都不许有」，而是**白名单制**：每处保留都要写明理由，
// 且数量写死 —— 新增一处会红，白名单里那几处被顺手迁掉也会红（提醒回来更新口径）。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/** 往上找到带 package.json 的那一层（单测会被 esbuild 打到 script/tmp-tests/ 下） */
function findRepoRoot(from: string): string {
    let dir = from;
    while (true) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const up = path.dirname(dir);
        if (up === dir) throw new Error("找不到仓库根（一路向上都没有 package.json）");
        dir = up;
    }
}

const ROOT = findRepoRoot(path.resolve(process.argv[1] ?? ".", ".."));
const WORKER = path.join(ROOT, "worker");

function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full, out);
        else if (/\.ts$/.test(name)) out.push(full);
    }
    return out;
}

/**
 * 剥掉注释再扫（保留行数，报错行号才对得上）。
 *
 * 必须剥：worker/lib/apiError.ts 的文件头注释里就举着 `Response.json({ error: ... })`
 * 这个例子，不剥会永远红在自己要说明的那段文字上（第一批守卫踩过同一个坑）。
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, m => "\n".repeat(m.split("\n").length - 1))
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

const FILES = walk(WORKER).map(f => ({
    rel: path.relative(ROOT, f).replace(/\\/g, "/"),
    text: stripComments(fs.readFileSync(f, "utf8")),
}));

/**
 * 每处 `{ success: false }` 的**应有**数量。写死而不是「> 0」：
 * 多一处会红（新的旧形状出口），少一处也会红（白名单里那处被迁掉了，回来更新口径）。
 *
 * 分成两组，理由完全不同：
 *   - 内部返回值：不在任何 Response.json 里，是 helper 的 return 对象
 *   - HTTP 出口：在 Response.json 里，但形状是「结果对象」不是「错误」
 */
const EXPECTED_INTERNAL: Record<string, number> = {
    // 上传 / 列表 / 下载 / 删除四个 helper 的返回值：调用方（backup.ts）拿它决定
    // 下一步，并且**自己**挑状态码。迁成 ApiError 就把两层揉成一层了。
    "worker/webdav/index.ts": 22,
    // 记事本备份任务的内部结果（status/trigger/keepFilename 等）。
    "worker/notesBackup.ts": 2,
};

const EXPECTED_HTTP: Record<string, number> = {
    // 向量补全的进度回报：`{ success:false, message, done, total }` ——
    // 这是「做到第几笔失败了」的部分成功形状，不是纯失败，给了 code 反而误导客户端。
    "worker/routes/ai.ts": 1,
    // webdav/notes 的 list / download：HTTP 200 + `{ success, code?, message }`，
    // 客户端（client.ts 的 notesBackupListRemote / notesBackupDownload）查 `.success`
    // 和 `.code`（code='encrypted' 时弹口令框）。迁成 4xx 会同时改状态码和分流方式。
    "worker/routes/backup.ts": 3,
};

function countSuccessFalse(text: string): number {
    return (text.match(/\bsuccess\s*:\s*false\b/g) ?? []).length;
}

test("worker/ 下 { success: false } 的数量与白名单逐文件一致", () => {
    const actual: Record<string, number> = {};
    for (const { rel, text } of FILES) {
        const n = countSuccessFalse(text);
        if (n > 0) actual[rel] = n;
    }
    const expected = { ...EXPECTED_INTERNAL, ...EXPECTED_HTTP };
    assert.deepEqual(
        actual,
        expected,
        "有文件的 { success: false } 数量变了。新增说明又写了旧的失败出口（改成 " +
        "errorResponse(ApiError.xxx(...))）；减少说明白名单里那处被迁掉了（回来更新 " +
        "EXPECTED_INTERNAL / EXPECTED_HTTP 与注释里的理由）。"
    );
});

test("白名单里那 4 处 HTTP 出口确实是「结果对象」而不是漏迁的错误", () => {
    const backup = FILES.find(f => f.rel === "worker/routes/backup.ts");
    assert.ok(backup, "没扫到 worker/routes/backup.ts");
    for (const phrase of [
        "获取备份列表失败",
        "下载备份失败",
        "这份文件里没有笔记数据（请确认选的是记事本备份）",
    ]) {
        assert.ok(
            backup.text.includes(phrase),
            `backup.ts 的 ${phrase} 不见了 —— 那三处结果对象被改过了，重新确认它们仍是 HTTP 200 形状`
        );
    }
    // 这三处必须仍在 webdav/notes 路由里（挪到别处就可能变成真正的错误出口）
    const notesSection = backup.text.slice(
        backup.text.indexOf('path === "webdav/notes/list"'),
        backup.text.indexOf('path === "webdav/notes/delete"')
    );
    assert.ok(notesSection.length > 0, "找不到 webdav/notes 那一段");
    assert.equal(countSuccessFalse(notesSection), 3, "webdav/notes 段内的 { success: false } 不是 3 处");

    const ai = FILES.find(f => f.rel === "worker/routes/ai.ts");
    assert.ok(ai, "没扫到 worker/routes/ai.ts");
    // 部分成功形状的指纹：done / total 两个计数字段必须还在
    assert.ok(
        /success\s*:\s*false[\s\S]{0,300}done:[\s\S]{0,80}total:/.test(ai.text),
        "ai.ts 那处不再带 done/total —— 它可能被改成纯失败了，回来更新白名单"
    );
});

test("迁移确实发生了：errorResponse(ApiError.…) 的出口数没有倒退", () => {
    // 2026-10-13 第二批迁了 70 处，加上第一批的存量，worker/ 下共 **92** 处
    // （data.ts 29 / account.ts 15 / backup.ts 12 / public.ts 10 / config.ts 9 /
    // ops.ts 7 / icon.ts 3 / middleware.ts 3 / loginGuard.ts 2 / idempotency.ts 1 /
    // index.ts 1）。
    // 2026-10-13 晚 CRUD 审查修复：data.ts 路由的 PUT 校验合并 —— PUT sites 的
    // 4 处 + PUT groups 的 2 处分散 errorResponse 合并为 validateSitePatch /
    // validateGroupPatch 之后的 3 处，92 → **89**。这是代码合并不是迁移回退：
    // 每处出口仍是 errorResponse(ApiError.…)。
    // 只增不减：新增合法迁移会让它变大，回退任意一处就会变小红。
    let total = 0;
    for (const { text } of FILES) total += (text.match(/errorResponse\(ApiError\./g) ?? []).length;
    assert.ok(
        total >= 89,
        `只有 ${total} 处 errorResponse(ApiError.…)，少于当前基线 89 处 —— 有人回退了迁移`
    );
});

test("迁移没把文案改掉：第二批这几条必须还在", () => {
    // 反向盯一下：迁移只加 code，不该顺手把用户看得见的文案改掉
    // （改文案等于改契约，客户端有测试与 UI 依赖原文）。
    const all = FILES.map(f => f.text).join("\n");
    for (const phrase of [
        "请先修改管理员密码后再进行其它操作",
        "该操作正在处理中，请稍后重试",
        "操作太频繁",
        "账号已不存在，请重新登录",
        "账号因长期未登录已被停用",
        "登录尝试过于频繁",
        "注册尝试过于频繁",
        "恢复请求过于频繁",
        "管理员凭据不可删除",
        "没有这个 AI 接口",
        "只能删除记事本备份文件",
        "一次最多删除 500 个",
    ]) {
        assert.ok(all.includes(phrase), `「${phrase}」在 worker/ 里找不到了 —— 迁移不该改文案`);
    }
});

test("守卫自身没跑空：确实扫到了文件，且扫到了该扫到的形状", () => {
    assert.ok(FILES.length >= 15, `只扫到 ${FILES.length} 个 worker 源文件，口径可能坏了`);
    // 反面：这个形状必须真的存在（一处都没有说明正则坏了，或者全仓已经迁完——
    // 那也该回来把这条守卫改成「不许再出现」而不是留一个永远绿的壳）
    const found = FILES.reduce((n, f) => n + countSuccessFalse(f.text), 0);
    assert.ok(found > 0, "一处 { success: false } 都没扫到，正则或者口径坏了");
    assert.ok(
        FILES.some(f => f.rel === "worker/routes/backup.ts" && /errorResponse\(ApiError\./.test(f.text)),
        "backup.ts 里没有 errorResponse(ApiError.…) —— 第二批迁移没落到这个文件上？"
    );
});

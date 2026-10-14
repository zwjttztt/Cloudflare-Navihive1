// script/sync-mirror.mjs
//
// 单向镜像同步：把「源站」的导航数据与笔记**覆盖式**搬到「镜像站」。
//
// 为什么是单向：本项目的 sites / groups 只有自增整数 id、没有 uuid，
// /api/sites/changes 只回「删了哪些」—— 那套变更流是给**客户端跨设备轮询**用的，
// 不是 server-to-server 的复制流。做双活等于重写一个同步引擎（详见
// docs/dual-deploy-arch-2026-10-14.md 的「为什么 ③ 双活不可行」）。
// 所以：一端写、另一端只读，定时全量覆盖。零冲突，代价是镜像端不能有写入。
//
// 三条通道（缺一条就静默丢数据）：
//   1. 导航：GET {src}/api/export  → POST {dst}/api/import      （覆盖式）
//   2. 笔记：GET {src}/api/notes/export → POST {dst}/api/notes/import（按 uuid 合并）
//   3. 附件：**本脚本不做**（见文件末尾「已知缺口」）
//
// 为什么导航备份不含笔记：exportData 刻意只管 groups/sites/configs
// （src/API/methods/transfer.ts），笔记有自己独立的备份体系。只配通道 1 的话，
// 切到镜像站会发现笔记全空 —— 这是最容易漏的一条。
//
// 用法：
//   MIRROR_SRC_URL=... MIRROR_SRC_USER=... MIRROR_SRC_PASS=... \
//   MIRROR_DST_URL=... MIRROR_DST_USER=... MIRROR_DST_PASS=... \
//   node script/sync-mirror.mjs [--dry-run] [--skip-notes] [--with-credentials] [--allow-writable] [--quiet]
//
// 凭据走环境变量、不走命令行参数：命令行参数会出现在 ps / shell history 里。
//
// 退出码（定时任务按它告警）：
//   0 成功；1 同步或对账失败；2 前置条件不满足（配置缺失 / 镜像站没开维护模式）

const REQUIRED_ENV = [
    "MIRROR_SRC_URL",
    "MIRROR_SRC_USER",
    "MIRROR_SRC_PASS",
    "MIRROR_DST_URL",
    "MIRROR_DST_USER",
    "MIRROR_DST_PASS",
];

/** 写请求的超时：导入是整批 INSERT + DELETE，几千条要跑好几秒 */
const WRITE_TIMEOUT_MS = 120_000;
/** 读请求的超时：导出要逐条解密站点密码 */
const READ_TIMEOUT_MS = 60_000;
/** 读失败重试次数。⚠️ 写请求**一律不重试**（理由见 push 处注释） */
const READ_RETRIES = 3;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipNotes = args.has("--skip-notes");
const withCredentials = args.has("--with-credentials");
const allowWritable = args.has("--allow-writable");
const quiet = args.has("--quiet");

const log = (...parts) => {
    if (!quiet) console.log("[mirror]", ...parts);
};
const warn = (...parts) => console.warn("[mirror][warn]", ...parts);

/** 缺配置就是配置错了，直接以 2 退出 —— 别让它变成「跑了一半的同步」 */
function readConfig() {
    const missing = REQUIRED_ENV.filter(name => !process.env[name]);
    if (missing.length) {
        console.error(`[mirror] 缺少环境变量：${missing.join(", ")}`);
        console.error("[mirror] 用法见 script/sync-mirror.mjs 文件头注释");
        process.exit(2);
    }
    const strip = url => url.replace(/\/+$/, "");
    return {
        src: {
            label: "源站",
            url: strip(process.env.MIRROR_SRC_URL),
            user: process.env.MIRROR_SRC_USER,
            pass: process.env.MIRROR_SRC_PASS,
        },
        dst: {
            label: "镜像站",
            url: strip(process.env.MIRROR_DST_URL),
            user: process.env.MIRROR_DST_USER,
            pass: process.env.MIRROR_DST_PASS,
        },
        stateFile: process.env.MIRROR_STATE_FILE || "mirror-sync-state.json",
    };
}

/**
 * 统一的请求出口。
 *
 * 两个刻意的选择：
 *   1. 非 GET 一律带 `Sec-Fetch-Site: same-origin`：服务端的同源判据
 *      （worker/httpUtils.ts 的 isSameOrigin）先看这个头，缺失时才退回 Origin。
 *      浏览器不会为跨站请求伪造这个值，脚本自己声明「我是同站的管理工具」，
 *      比依赖「两个头都没有就放行」这条兜底更明确，将来判据收紧也不会突然 403。
 *      ⚠️ 反过来绝不能带 Origin —— 带了就走 host 比对，脚本的 host 与站点不一致必被拦。
 *   2. 不自动跟随 30x：登录被反代重定向到别处时，宁可报错也不要把凭据贴到新地址上。
 */
async function request(url, { method = "GET", cookie, body, timeoutMs }) {
    const headers = { Accept: "application/json" };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["Sec-Fetch-Site"] = "same-origin";

    const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // 有些错误响应是纯文本（网关 / 反代），留着原样给报错用
    }
    return { status: res.status, ok: res.ok, json, text, cookie: cookieOf(res) };
}

/** 只取 Set-Cookie 的 name=value 部分：属性（Path / HttpOnly / Secure）不是 Cookie 头的内容 */
function cookieOf(res) {
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const jar = raw.map(c => c.split(";")[0].trim()).filter(Boolean);
    return jar.join("; ");
}

/** 登录拿会话 cookie。令牌只落在 httpOnly cookie 里，响应体没有 token 可取 */
async function login(site) {
    const res = await request(`${site.url}/api/login`, {
        method: "POST",
        body: { username: site.user, password: site.pass },
        timeoutMs: READ_TIMEOUT_MS,
    });
    if (!res.ok) {
        throw new Error(
            `${site.label} 登录失败（HTTP ${res.status}）：${res.json?.message || res.text.slice(0, 200)}`
        );
    }
    if (!res.cookie) {
        throw new Error(`${site.label} 登录成功但没有拿到会话 cookie —— 检查反代是否吞了 Set-Cookie`);
    }
    return res.cookie;
}

/**
 * 读接口带重试：跨境链路抖一下就失败，重试是安全的（幂等读）。
 * 写接口**不重试** ——理由写在调用处。
 */
async function readJson(site, cookie, path, timeoutMs = READ_TIMEOUT_MS) {
    let lastErr;
    for (let attempt = 1; attempt <= READ_RETRIES; attempt++) {
        try {
            const res = await request(`${site.url}/api/${path}`, { cookie, timeoutMs });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} ${res.json?.message || res.text.slice(0, 200)}`);
            }
            return res.json;
        } catch (err) {
            lastErr = err;
            if (attempt < READ_RETRIES) {
                const waitMs = 1000 * attempt;
                warn(`${site.label} GET /api/${path} 第 ${attempt} 次失败（${err.message}），${waitMs}ms 后重试`);
                await new Promise(r => setTimeout(r, waitMs));
            }
        }
    }
    throw new Error(`${site.label} GET /api/${path} 连续 ${READ_RETRIES} 次失败：${lastErr.message}`);
}

/** 写接口：不重试、不走 --dry-run */
async function writeJson(site, cookie, path, body, timeoutMs = WRITE_TIMEOUT_MS) {
    if (dryRun) {
        throw new Error(`--dry-run 下不该发起写请求（${site.label} POST /api/${path}）—— 这是脚本自身的 bug`);
    }
    const res = await request(`${site.url}/api/${path}`, {
        method: "POST",
        cookie,
        body,
        timeoutMs,
    });
    if (!res.ok) {
        throw new Error(`${site.label} POST /api/${path} 失败（HTTP ${res.status}）：${res.json?.message || res.text.slice(0, 200)}`);
    }
    return res.json;
}

/**
 * 前置闸门：镜像站必须处于维护模式。
 *
 * 为什么必须挡：镜像站一旦可写，别人（或你自己误登）写进去的东西会在下一次同步
 * 被整批覆盖，且**没有任何提示**。代码里已有的维护模式（worker/routes/middleware.ts
 * 的 enforceMaintenance）正好做这件事：写操作 503、读操作放行、owner 豁免 ——
 * 所以同步脚本用 **owner** 登录时仍能写入，而其他人一律被拦。
 *
 * 只读 /api/init 拿 maintenance 字段（公开路由，不需要登录），拿不到就按「没开」处理。
 */
async function assertMirrorReadOnly(dst) {
    if (allowWritable) {
        warn("--allow-writable：跳过镜像站只读检查。镜像站上的写入会被下一次同步静默覆盖");
        return;
    }
    let init;
    try {
        init = await readJson(dst, "", "init");
    } catch (err) {
        // 连 /api/init 都读不到，说明地址或网络有问题 —— 这同样是「不能确认镜像站只读」，
        // 按前置条件不满足退出（2），而不是「同步失败」（1）
        console.error(`[mirror] 读不到镜像站的 /api/init：${err.message}`);
        process.exit(2);
    }
    if (init?.maintenance !== true) {
        console.error(
            [
                `[mirror] 镜像站 ${dst.url} 没开维护模式，拒绝同步。`,
                "         镜像站可写 = 那里的写入会在下一次同步被静默覆盖。",
                "         用所有者账号登录镜像站 → 设置里打开维护模式，或：",
                `         curl -X PUT '${dst.url}/api/configs/maintenance.enabled' \\`,
                "              -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \\",
                `              -H "Cookie: <登录后的 cookie>" -d '{\"value\":\"1\"}'`,
                "         （确实没人写镜像站时，可用 --allow-writable 跳过这道闸）",
            ].join("\n")
        );
        process.exit(2);
    }
    log("镜像站处于维护模式（写操作对非所有者 503）—— 只读前提成立");
}

/**
 * 临时打开源站的「备份含登录凭据」。
 *
 * exportData 默认把站点账号密码抹掉（明文 JSON 备份会被同步到网盘）。镜像同步走的是
 * 两个 HTTPS 站点之间的直传，不落网盘，所以这里按需临时打开、导出后**立刻还原**。
 * ⚠️ 还原失败要大声喊出来：留着 true 意味着之后的 WebDAV 备份里会带上明文凭据。
 */
async function withBackupCredentials(src, cookie, fn) {
    const KEY = "backup.includeCredentials";
    const current = await readJson(src, cookie, `configs/${KEY}`);
    const previous = current?.value ?? null;
    if (previous === "true") return await fn();

    const put = async (value, method) => {
        const res = await request(`${src.url}/api/configs/${KEY}`, {
            method,
            cookie,
            body: method === "PUT" ? { value } : undefined,
            timeoutMs: WRITE_TIMEOUT_MS,
        });
        if (!res.ok) {
            throw new Error(`设置 ${KEY} 失败（HTTP ${res.status}）：${res.json?.message || res.text.slice(0, 200)}`);
        }
    };
    await put("true", "PUT");
    try {
        return await fn();
    } finally {
        // 原本没有这个键就删掉，别留一个空串配置在那儿（之后每次都会走一遍开关）
        try {
            await put(previous, previous === null ? "DELETE" : "PUT");
        } catch (err) {
            warn(`还原 ${KEY} 失败，它现在可能还是 true —— 之后的备份文件会带上明文凭据，请手动改回：${err.message}`);
        }
    }
}

/** 对账：源站与镜像站的条数必须一致（笔记允许镜像站更多，见下） */
async function reconcile(src, srcCookie, dst, dstCookie) {
    const count = async (site, cookie) => {
        const [groups, sites, notesCount] = await Promise.all([
            readJson(site, cookie, "groups"),
            readJson(site, cookie, "sites"),
            readJson(site, cookie, "notes/count"),
        ]);
        return {
            groups: Array.isArray(groups) ? groups.length : -1,
            sites: Array.isArray(sites) ? sites.length : -1,
            notes: notesCount?.count ?? -1,
        };
    };
    const [a, b] = await Promise.all([count(src, srcCookie), count(dst, dstCookie)]);
    log(`对账  源站 分组 ${a.groups} / 站点 ${a.sites} / 笔记 ${a.notes}`);
    log(`对账  镜像 分组 ${b.groups} / 站点 ${b.sites} / 笔记 ${b.notes}`);

    const problems = [];
    if (b.groups !== a.groups) problems.push(`分组数不一致（${a.groups} → ${b.groups}）`);
    if (b.sites !== a.sites) problems.push(`站点数不一致（${a.sites} → ${b.sites}）`);
    // 笔记导入是 merge（按 uuid + updated_at），镜像站比源站多是**允许的**：
    // 那说明镜像站上有源站没有的笔记，merge 不会删它，不算丢数据 —— 但它也提示
    // 「有人在镜像站写过」，值得喊一嗓子。
    if (b.notes < a.notes) problems.push(`笔记数比源站少（${a.notes} → ${b.notes}）—— 笔记没搬全`);
    if (b.notes > a.notes) {
        warn(`镜像站笔记比源站多 ${b.notes - a.notes} 条：merge 不动它们，但这通常意味着镜像站被写过`);
    }
    return { src: a, dst: b, problems };
}

async function main() {
    const cfg = readConfig();
    log(`源站  ${cfg.src.url}`);
    log(`镜像站 ${cfg.dst.url}`);
    if (dryRun) log("--dry-run：只导出与统计，不往镜像站写一个字节");

    const srcCookie = await login(cfg.src);
    log("源站 登录成功");

    // 闸门必须在任何写入之前：镜像站可写就整批退出，一个字节都不搬
    await assertMirrorReadOnly(cfg.dst);

    const dstCookie = dryRun ? "" : await login(cfg.dst);
    if (!dryRun) log("镜像站 登录成功（必须是所有者：非所有者在维护模式下写操作会被 503）");

    // ---- 通道 1：导航数据 ----
    const exportNav = () => readJson(cfg.src, srcCookie, "export");
    // --dry-run 下不去动源站的那条配置：试跑不该在任何一端留下写痕
    const nav =
        withCredentials && !dryRun
            ? await withBackupCredentials(cfg.src, srcCookie, exportNav)
            : await exportNav();
    if (withCredentials && dryRun) {
        warn("--dry-run 下不临时开启「备份含登录凭据」，导出内容按源站当前设置为准");
    }
    log(`导出导航：分组 ${nav.groups?.length ?? 0} / 站点 ${nav.sites?.length ?? 0}`);

    if (!dryRun) {
        // ⚠️ 不重试：/api/import 是「先 INSERT 备份内容、成功后才 DELETE 旧数据」，
        // 中途失败重来一次会再插一批，镜像站短期出现重复行。让它失败退出、等下一轮
        // 定时任务整批覆盖更干净（下一轮成功时旧数据会被整体删掉，自然收敛）。
        const result = await writeJson(cfg.dst, dstCookie, "import", nav);
        log(`导入导航：${JSON.stringify(result).slice(0, 300)}`);
    }

    // ---- 通道 2：笔记 ----
    let notes = null;
    if (!skipNotes) {
        notes = await readJson(cfg.src, srcCookie, "notes/export");
        log(`导出笔记：${notes?.notes?.length ?? 0} 条 / 文件夹 ${notes?.folders?.length ?? 0} / 标签 ${notes?.tags?.length ?? 0}`);
        if (!dryRun) {
            const result = await writeJson(cfg.dst, dstCookie, "notes/import", notes);
            log(`导入笔记：${JSON.stringify(result).slice(0, 300)}`);
        }
    } else {
        log("--skip-notes：跳过笔记通道（镜像站的笔记会停在上一轮的状态）");
    }

    if (dryRun) {
        log("--dry-run 结束：以上只是源站的导出结果，镜像站未被改动");
        return { dryRun: true };
    }

    const { src, dst, problems } = await reconcile(cfg.src, srcCookie, cfg.dst, dstCookie);
    if (problems.length) {
        console.error(`[mirror] 对账不通过：${problems.join("；")}`);
        process.exit(1);
    }
    log("对账通过");
    return { src, dst };
}

const startedAt = Date.now();
try {
    const result = await main();
    if (!result.dryRun) {
        const state = {
            lastSuccessAt: new Date().toISOString(),
            src: process.env.MIRROR_SRC_URL,
            dst: process.env.MIRROR_DST_URL,
            srcCounts: result.src,
            dstCounts: result.dst,
            durationMs: Date.now() - startedAt,
        };
        const { writeFile } = await import("node:fs/promises");
        await writeFile(process.env.MIRROR_STATE_FILE || "mirror-sync-state.json", JSON.stringify(state, null, 2));
        log(`状态已写入 ${process.env.MIRROR_STATE_FILE || "mirror-sync-state.json"}（监控看它的 mtime 判定新鲜度）`);
    }
    console.log("[mirror] 同步完成");
} catch (err) {
    console.error(`[mirror] 同步失败：${err?.message || err}`);
    process.exit(1);
}

// ---- 已知缺口（刻意不做，别当成 bug）----
//   1. 附件不同步：笔记图片存在各自的存储里（CF 是 KV、自托管是目录），
//      上传接口由服务端发 uuid，没有「按原 id 幂等写入」的口子 —— 强行搬会把
//      笔记正文里的图片引用指到不存在的 id 上。当前两端都还没有附件，等有了再说。
//   2. 站点 id 会重发号：/api/import 一律由数据库重新分配 id（避免撞主键），
//      所以镜像站上按站点 id 存的本机数据（星标 / 标签）每轮同步后都要重新对应。
//      导航数据本身不受影响。
//   3. 回收站 / 审计日志 / 分享链接不在同步范围内：它们是「这一站自己的运维数据」，
//      不是站点内容。

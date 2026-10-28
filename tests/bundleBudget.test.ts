// tests/bundleBudget.test.ts
// 首屏体积预算。**两个口径**（2026-10-05 起）：
//
//   1. 真实首屏总量 —— index.html 里 script + modulepreload + css 的**全部**兄弟文件
//      （914.1 KB / gzip 295.2 KB）。这才是用户实际下载的字节。
//   2. index chunk 单文件（历史口径，221.18 KB）—— 保留，因为它是有用的**子指标**：
//      业务代码进首屏时它会涨，而 MUI 升版本不会。
//
// 为什么要有第 1 个口径：原来只有第 2 个，而 Vite 会在 index.html 里给首屏静态依赖发
// `modulepreload` —— 那些是浏览器**必定要下**的。实测 index chunk 只占真实首屏的 23.7%，
// 另外 76.3%（约 697 KB）完全不受约束：谁把 MUI 涨一涨，CI 全绿，只有用户感觉首屏变慢。
// 更要紧的是，之前几次「首屏 264 → 221 KB」的成绩单其实只动了真实首屏的四分之一。
//
// 为什么需要这个守卫：把弹窗改成 lazy 那次把首屏从 264 KB 压到 231 KB，再拆出 LoginForm
// 之后是 222.61 KB（gzip 75.65）。但这类成果**没有任何东西在守着** ——
// 下次有人为了省事把一个大组件改回同步 import，包会悄悄涨回去，
// 而且涨的那一刻 CI 是绿的，只有用户觉得首屏变慢了。
//
// 所以这里钉上限：超了就红，逼着改动的人要么继续拆，要么明确上调预算并说明理由。
// 没构建过（dist 不存在）时跳过 —— 单测不该要求先跑一次 build。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
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

// ⚠️ 2026-10-12 分块策略变更后，首屏真正用到的 MUI 直接并入 index 块
//（原来它们在被 preload 的 mui 块里）：index 225.8 → 348.29 KB，
// 而首屏总字节反而从 943.3 降到 495.1 KB。所以这里不是「放宽预算」，
// 是**单个块不再是首屏字节的代表** —— 判断首屏请看上面那组 raw / gzip，
// 这条只用来盯「index 块本身有没有被人塞东西」（余量仍按 ≥5% 判）。
//
// ⚠️ 2026-10-23 #477 站点↔笔记绑定：252 → 256。
// 卡片角上多了第三个浮层控件（笔记入口），实测 index 238.44 → 240.04 KB（+1.6 KB：
// 一个图标模块 + 一枚按钮）。这是**首屏真要用到**的常驻控件 —— 用户不打开任何弹窗
// 就能看到它，不属于「弹窗代码被焊回首屏」那一类，所以不往下砍而是照实抬预算；
// 抬完余量 6.2%，「谁再往首屏塞东西」这个信号照样抓得住。
//
// ⚠️ 2026-10-28 批次一（认证链路 + 观测性）：256 → 258。
// 实测 245.26 KB，按 256 算只剩 4.38%，差 1.45 KB 到 5% 线。这一批进首屏的是：
//   · `components/RenderBoundary.tsx`（约 1.3 KB）—— 包住 `<SiteListBody>` 与
//     「登录页」两处。**它必须常驻**：得在卡片渲染崩掉的那一刻已经在树上才接得住异常，
//     改成 lazy 就等于「出事之后再加载兜底」，那时子树已经抛错了。
//     所以本用例要求的第一条（「把只在触发后才出现的组件改成 lazy」）对它不适用 ——
//     常驻的是**边界本身**，只有它内部那段兜底 UI 是出错后才出现的，而两者在同一份
//     代码里，拆不开。
//   · `apiError.ts` 的 `isAuthError` + `transport.ts` 的 `notifyUnauthorized`
//     + `client.ts` 读 `x-request-id`（合计约 0.4 KB）
// 抬完余量 5.2% —— 比惯例的 6% 紧，是**故意的**：这一批花掉的是 10-23 之后攒下的
// 那点余量，再往上垫就是替后面的人预支。下一次真需要空间时，正确的刀是
// 「把 RenderBoundary 与根上的 ErrorBoundary 合并成同一个组件、用 prop 区分整页 / 局部
// 两种呈现」（目前两份各自带一套内联样式，约 1.3 KB × 2），而不是继续抬这个数字。
const BUDGET_KB = 258;
/**
 * 基线：每次真的把首屏压下来之后都要跟着更新，否则这条用例会一路放任包变大。
 * 222.61 KB —— LoginForm 改 lazy 之后（见 git log）
 * 221.18 KB —— 底部批量条 BulkActionBar 改 lazy 之后：它只有进入多选才出现，
 *              却一直躺在首屏里（6.46 KB）。首屏预算当时只剩 7 KB 余量，
 *              这是当时最干净的一刀（其余大块都是首屏真要用到的：
 *              App 26 KB、SiteCard 12 KB、client 10 KB、GroupCard 10 KB）。
 * 224.60 KB —— 2026-10-05 修「记事本 500」那轮顺手做的两刀：
 *              TagBar（只在有标签 / 死链 / 星标筛选时出现）、
 *              SiteListSkeleton（只在 loading 时挂）。
 *              这两个都是**真条件渲染**，不是把常驻组件硬拆出去骗指标。
 *              （同轮还试过把 HeaderGroupsButton 也改 lazy，能再省 0.4 KB，
 *                但它属于分组栏那条线，按要求整块回退了，所以基线是这个数。）
 *
 * 预算 236 → 238 —— 2026-10-11 运维统计看板那批改动。涨的是**首屏真要用到的东西**，
 * 不是忘了拆：看板弹窗本身走 lazy（独立 chunk），服务端的聚合 SQL 也留在 worker 里
 * （首屏里搜不到 auditDaily / shareTop 等字段），进首屏的只有三处小改 —— 更多菜单里
 * 多一个入口项与图标、卡片右键多一个「重新检测该站」、链接健康的键归一化与撤销纠偏。
 * 涨完余量 5.4%，仍留得住「有人往首屏塞东西」这个信号。
 */
/**
 * ⚠️ 2026-10-12 分块再次变更（同一天里的第二次，方向与早上那次相反）：
 * 懒加载弹窗共用的 MUI 全部合并成 **mui-lazy** 一个块（约 415 KB），
 * 于是 index 从 352.6 掉到 **236.7 KB** —— 首屏的 MUI 不在入口块里了，
 * 而是被 HTML preload 的 mui-lazy 块。
 *
 * 为什么这次是「合并」而不是早上那次的「拆开」：这条链路上**每个请求固定 1~3 秒**
 * （实测 10 字节的接口也要 3.85 秒），请求数比字节贵得多。本地对照实测
 * （首屏 + 打开记事本两阶段合计）：
 *   拆开（169 块）  ：94 个请求 / JS 67 个 / 2457 KB
 *   只修假 lazy     ：56 个请求 / JS 29 个 / 2255 KB
 *   再合并 mui-lazy ：**42 个请求 / JS 15 个 / 2271 KB**
 * 也就是说：多下 16 KB，换少 14 个请求 —— 在这条链路上是净赚。
 * 这条基线跟着落到 236.7，index 块本身不再是首屏字节的代表（仍是有用的子指标）。
 *
 * 235.84 —— 同日第三次：`utils/recoveryKey` 那组（约 3 KB）挪出首屏。
 * 静态 import 它的 `useAccountSession` 在入口块里，而它只有「账号管理 → 生成恢复密钥」
 * 这一条路径用得到，登录页那份本来就是 lazy。改成**调用时才动态 import** 之后，
 * rolldown 把它并进 LoginForm 那个块（9589 → 9690 字节，只多 101 字节），
 * 所以没有多出任何请求 —— 首次点这一下时把登录页那 9 KB 顺带拉下来而已。
 * （顺带排除了另一个候选 `methods/transfer`：它 2.29 KB，但 `filterOwnedGroupIds`
 *   在**拖拽排序**路径上，动态化会让每次排序多等一个 chunk，那笔账是亏的。）
 *
 * 237.25 —— 2026-10-13 首屏请求数那一轮：+0.62 KB 换 **-1 个请求**。
 * `MaintenanceBanner`（790 字节）原来是 lazy 块，但它必须常驻（自己每 60 秒轮询
 * 维护状态），lazy 省不掉下载、只剩一个独立请求；改回静态 import 后并进入口块。
 * （同期另外两刀没动 index：`GroupCard` 的 `EditGroupDialog` 由「无条件渲染」
 *   改成 `ChunkBoundary when={editDialogOpen}`，`preload-helper` 并进 vendor 的尝试
 *   因为 rolldown 自己发的 `rolldown-runtime` 块填不上那个坑而回退 —— 详见 CHANGELOG。）
 *
 * 238.44 —— 2026-10-14 复测修正：**不是新代码，是构建产物漂移**。
 * `git diff dc46173..HEAD -- src/` 是空的（客户端一行没改），重新 build 出来的
 * index 块却是 244160 字节（238.44 KB），比当时记的 237.25 多 1.19 KB ——
 *  rolldown-vite 换版本后的输出差异。基线照实更新，预算同步 250 → 252，
 * 仍然守住「离上限至少 5%」这个信号（现在 5.7%）。
 */
const BASELINE_KB = 238.44;

function indexChunk(): { name: string; kb: number } | null {
    const assets = join(findProjectDir(), "dist", "client", "assets");
    let files: string[];
    try {
        files = readdirSync(assets);
    } catch {
        return null;
    }
    const hit = files.find(f => /^index-.*\.js$/.test(f));
    if (!hit) return null;
    const bytes = readFileSync(join(assets, hit)).length;
    return { name: hit, kb: bytes / 1024 };
}

// ---------------------------------------------------------------------------
// 真实首屏：index.html 里 script + modulepreload + css 的**全部**兄弟文件
// ---------------------------------------------------------------------------
//
// 为什么必须加总（2026-10-05 修）：上面那条只盯 index chunk，而 Vite 会在 index.html 里
// 给首屏的静态依赖发 `modulepreload` —— 那些是浏览器**必定要下**的。
// 实测（main @ affaf2b）：
//   index 216.6 + mui 402.6 + react 202.0 + vendor 75.3 + runtime/css 17.6 = 914.1 KB
// 也就是说 index chunk 只占真实首屏的 23.7%，另外 76.3%（约 697 KB）当时完全不受约束 ——
// 谁把 MUI 涨一涨，CI 全绿，只有用户感觉首屏变慢。
// 更要紧的是：之前几次「首屏 264 → 221 KB」的成绩单，其实只动了真实首屏的四分之一。
//
// gzip 也要断言：用户实际下载的是压缩后的字节，那才是体感。
// ⚠️ 2026-10-05 阶段一 + 阶段二后，记事本新增标题下拉（Menu/MenuItem）、折叠开关
// （FirstPage/LastPage）等共约 14 个 MUI 图标与组件，真实首屏 914→920.6 KB / 295.2→296.7 KB。
// 预算从 950/305 抬到 970/315：留不出余量的话，「东西加多了」这个信号会被这条测试吞掉，
// 那才是真的坏 —— 抬完仍要求至少 3% 余量，再涨 6 KB 就红。
// ⚠️ 2026-10-11 依赖例行升级（MUI 9.4→9.5 等 minor/patch）后实测 943.3/304.0，
// 970/315 只剩 2.8%/3.5% 余量 —— 涨价来自依赖升级而非代码进场，预算抬到 995/322
//（恢复约 5% 余量的设计意图），基线同步更新到本次实测。
//
// ⚠️ 2026-10-12 分块策略变更：@mui/@emotion/@popperjs/@floating-ui 不再被强制
// 塞进同一个 "mui" 块（见 vite.config.ts 那条规则与它的实测数据）。原来首屏
// modulepreload 整个 422.8 KB 的 mui 块，其中约 300 KB 是弹窗 / 抽屉 / 记事本
// 专用、首屏根本用不到的组件；交回 Rollup 后它们自动落进各自的 lazy 块，
// 首屏只剩真正要用到的那部分。
// 实测：943.3 / 304.0 → **843.4 / 282.7**（raw -10.6%、gzip -7.0%）。
// 预算按新口径下调到 890 / 300 —— 不是放宽，是首屏真的变小了，
// 「谁再往首屏塞东西」这个信号照样抓得住（余量仍按 ≥3% 判）。
/**
 * ⚠️ 2026-10-12 第二次分块变更（lazy 弹窗的 MUI 合并成 mui-lazy 一块）：
 * 首屏从 843.4 / 282.7 涨到 **949.9 / 307.4 KB**，但首屏文件数从 11 降到 6、
 * JS 请求从 20 降到 9。在这条「每个请求固定 1~3 秒」的链路上，少 11 个请求
 * 远比多 107 KB 划算（107 KB 在这条链路上是几秒，11 个请求是十几到三十几秒）。
 * 所以预算上调到 1000 / 325 —— 不是放任，是**衡量的口径变了**：
 * 这条链路上的首屏成本 ≈ 请求数 × 固定往返 + 字节 / 吞吐，两边都要盯（下面新增
 * 的那条「首屏 JS 块不超过 8 个」正是盯住请求数那一半）。
 */
const FIRST_SCREEN_BUDGET_RAW_KB = 920;
const FIRST_SCREEN_BUDGET_GZIP_KB = 300;
/**
 * 实测基线（2026-10-17 P2-2 第三次分块变更）：852.4 KB 原始 / 280.1 KB gzip。
 * mui-lazy 大块（417KB，内含大量弹窗专用组件）被彻底拆掉：首屏 preload 改为
 * 源码层扫描出的「首屏真用到的 @mui/material 闭包」单一 mui-core 块（328KB），
 * 弹窗专用的 MUI 只被动态 import，不再出现在 index.html 的 preload 列表里。
 * 首屏请求数仍为 6（JS 5 个），字节 -10%。
 * 同轮 P2-1：笔记首拉先探 count（?fields=list 摘要阀门提前生效），不影响体积。
 *
 * 874.2 / 286.6 —— 2026-10-25 照实更新（**不是新口径，是三轮真涨**）：
 *   v12.6.0 笔记美化的排版语言（标题层级 / 块变量 / 标签色板 / 三档列表）＋
 *   v12.7.0 视觉对齐（圆角派生 / hover / 卡片阴影）＋ 本轮全站一致性
 *   （`::selection`、`--scrim-modal`、`--header-radius`、`--notes-font-scale`）。
 *   这 21.8 KB 全是首屏真要用到的 CSS 与主题 token，没有把弹窗硬拆出去骗指标；
 *   预算同步 900 → 920，把「离上限至少 3%」的信号重新立住（现余量 5.2%）。
 *   ⚠️ 下次再涨请先确认是「内容涨」还是「有组件被改回同步 import」。
 */
const FIRST_SCREEN_BASELINE_RAW_KB = 874.2;
const FIRST_SCREEN_BASELINE_GZIP_KB = 286.6;

interface FirstScreen {
    files: { name: string; rawKb: number; gzipKb: number }[];
    rawKb: number;
    gzipKb: number;
}

function firstScreen(): FirstScreen | null {
    const dir = findProjectDir();
    let html: string;
    try {
        html = readFileSync(join(dir, "dist", "client", "index.html"), "utf-8");
    } catch {
        return null;
    }
    // script 的 src 与 modulepreload / stylesheet 的 href 都是首屏必下文件
    const names = [
        ...new Set(
            [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map(m => m[1])
        ),
    ];
    const files: FirstScreen["files"] = [];
    let raw = 0;
    let gzip = 0;
    for (const name of names) {
        let bytes: Buffer;
        try {
            bytes = readFileSync(join(dir, "dist", "client", "assets", name));
        } catch {
            continue;
        }
        const gz = gzipSync(bytes, { level: 9 }).length;
        files.push({ name, rawKb: bytes.length / 1024, gzipKb: gz / 1024 });
        raw += bytes.length;
        gzip += gz;
    }
    return { files, rawKb: raw / 1024, gzipKb: gzip / 1024 };
}

test("真实首屏（index.html 的 script + modulepreload + css 合计）不超预算", t => {
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    const detail = fs.files.map(f => `${f.name} ${f.rawKb.toFixed(1)}KB`).join("、");
    assert.ok(
        fs.rawKb <= FIRST_SCREEN_BUDGET_RAW_KB,
        `真实首屏 ${fs.rawKb.toFixed(1)} KB（gzip ${fs.gzipKb.toFixed(1)} KB），` +
            `超过预算 ${FIRST_SCREEN_BUDGET_RAW_KB} KB。构成：${detail}。` +
            `多半是某个只在触发后才出现的组件被改回了同步 import —— 先看它该不该走 lazy。`
    );
    assert.ok(
        fs.gzipKb <= FIRST_SCREEN_BUDGET_GZIP_KB,
        `真实首屏 gzip ${fs.gzipKb.toFixed(1)} KB，超过预算 ${FIRST_SCREEN_BUDGET_GZIP_KB} KB。` +
            `构成：${fs.files.map(f => `${f.name} ${f.gzipKb.toFixed(1)}KB`).join("、")}。` +
            `gzip 才是用户实际下载的字节，它比原始体积更能反映体感。`
    );
});

// ⚠️ 标题里的百分比必须与下面的断言一致 —— 2026-10-24 全站复查发现这里写着 5%、
// 实际断言是 3%，报告上「还有 5% 余量」是假的。
// 设计意图确实是 5%（离上限还有多少增长空间），但**当前实测只有 3.3% / 5.0%**：
// raw 871.3 KB 距 5% 线（857.1 KB）还差约 14 KB，靠抬预算把数字做漂亮是自欺欺人。
// 所以这里如实写 3%，缺口留在这条注释里：真把首屏压下来之后，把断言和标题一起
// 改回 0.05（同一处改，别只改一个）。
test("**当前**真实首屏也要留 3% 余量，不只是基线留", t => {
    // 和上面那条 index chunk 的余量用例同一个道理：基线只在真把首屏压下来时才更新，
    // 中间加进去的几 KB 它看不见。真正该红的是「现在离上限还有多远」。
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    const rawHeadroom = (FIRST_SCREEN_BUDGET_RAW_KB - fs.rawKb) / fs.rawKb;
    const gzipHeadroom = (FIRST_SCREEN_BUDGET_GZIP_KB - fs.gzipKb) / fs.gzipKb;
    assert.ok(
        rawHeadroom >= 0.03 && gzipHeadroom >= 0.03,
        `当前真实首屏 ${fs.rawKb.toFixed(1)} KB / gzip ${fs.gzipKb.toFixed(1)} KB，` +
            `离预算只剩 ${(rawHeadroom * 100).toFixed(1)}% / ${(gzipHeadroom * 100).toFixed(1)}%` +
            `（各留至少 3%；设计目标是 5%，未达成 —— 见本用例上方的注释）。`
    );
});

test("首屏预算的基线常量要与实测相符（别让基线悄悄过期）", t => {
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    // 基线是「上次实测值」。它与真实值差太远，说明中间发生了大改动 ——
    // 确认是有意为之的话，连同理由一起更新这两个常量。
    const rawDrift = Math.abs(fs.rawKb - FIRST_SCREEN_BASELINE_RAW_KB) / FIRST_SCREEN_BASELINE_RAW_KB;
    const gzipDrift = Math.abs(fs.gzipKb - FIRST_SCREEN_BASELINE_GZIP_KB) / FIRST_SCREEN_BASELINE_GZIP_KB;
    assert.ok(
        rawDrift <= 0.05 && gzipDrift <= 0.05,
        `实测 ${fs.rawKb.toFixed(1)} KB / gzip ${fs.gzipKb.toFixed(1)} KB 与基线 ` +
            `${FIRST_SCREEN_BASELINE_RAW_KB} KB / ${FIRST_SCREEN_BASELINE_GZIP_KB} KB 分别差 ` +
            `${(rawDrift * 100).toFixed(1)}% / ${(gzipDrift * 100).toFixed(1)}%。` +
            `若是有意压下去的，把基线更新掉；若是涨上来的，先查是什么进了首屏。`
    );
});

test("首屏文件清单要能看出少了谁（防止统计口径悄悄失效）", t => {
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    const names = fs.files.map(f => f.name);
    const has = (re: RegExp) => names.some(n => re.test(n));
    // 这几条是当前首屏的固定组成（入口 / 两个 vendor 块 / 样式）。
    // 少任何一条都说明统计口径坏了 —— 而不是「优化掉了」，
    // 因为入口 HTML 必然引用它们。真要减首屏请先改这里的前提。
    //
    // ⚠️ 2026-10-12：原来这里还断言 `^mui-.*\.js$`。分块策略变更后 MUI 不再单独
    // 成块（见 vite.config.ts），那条断言会恒定失败 —— 它不是「首屏缺了东西」，
    // 而是「统计口径的前提变了」。现在的首屏由 index + react + vendor + 若干
    // 小的共享块（utils / TextField / Modal …）+ 样式构成。
    assert.ok(has(/^index-.*\.js$/), "没统计到入口 chunk");
    assert.ok(has(/^react-.*\.js$/), "没统计到 react 块");
    assert.ok(has(/^vendor-.*\.js$/), "没统计到 vendor 块");
    assert.ok(names.filter(n => n.endsWith(".js")).length >= 4, "首屏 JS 块数量异常偏少，口径可能坏了");
    assert.ok(has(/\.css$/), "没统计到样式文件");

    // 2026-10-12 新增：首屏 JS 块**不能多**。
    // 体积预算盯的是字节，但这条链路上每个请求还要另付 1~3 秒的固定往返
    // （实测 10 字节的接口 TTFB 3.85 秒）—— 字节省下来了、块数却涨回去，
    // 用户只会更慢。实测 6 个块（index / preload-helper / mui-lazy / react / vendor，
    // 外加样式）；上限给 8，留一点余量给将来新增的共享块。
    const jsBlocks = names.filter(n => n.endsWith(".js"));
    assert.ok(
        jsBlocks.length <= 8,
        `首屏 JS 块有 ${jsBlocks.length} 个（${jsBlocks.join("、")}），超过 8 个。` +
            `每个块都是一次独立往返，在这条链路上比字节更贵 —— 先去 vite.config.ts 合块`
    );
});

test("首屏包（index chunk）不超过体积预算", t => {
    const chunk = indexChunk();
    if (!chunk) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    assert.ok(
        chunk.kb <= BUDGET_KB,
        `首屏包 ${chunk.name} 现在 ${chunk.kb.toFixed(2)} KB，超过预算 ${BUDGET_KB} KB` +
            `（基线 ${BASELINE_KB} KB）。多半是有组件被改回了同步 import ——` +
            `先确认是不是该走 lazy；确实要上调预算的话，请连同理由一起改这条用例。`
    );
});

test("首屏包体积预算本身要留有余量（基线不能贴着上限）", () => {
    // 预算贴着基线写，等于每次微调构建都会红。留至少 5% 的余量，
    // 红的才是「真的有人在往首屏里塞东西」而不是「MUI 升了个小版本」。
    const headroom = (BUDGET_KB - BASELINE_KB) / BASELINE_KB;
    assert.ok(headroom >= 0.05, `预算余量只有 ${(headroom * 100).toFixed(1)}%，太紧了`);
});

test("**当前**首屏包也要留 5% 余量，不只是基线留", t => {
    // 上面那条是按基线算的。基线只在「真的把首屏压下来」时才更新，
    // 于是中间陆续加进去的几 KB 它一概看不见 —— 实测出现过基线余量 6.25%、
    // 实际余量只剩 4.24% 的情况，用例却是绿的。
    // 真正会红的应该是「现在这个包离上限还有多远」，所以这里按当前体积再算一遍。
    const chunk = indexChunk();
    if (!chunk) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    const actual = (BUDGET_KB - chunk.kb) / chunk.kb;
    assert.ok(
        actual >= 0.05,
        `当前首屏包 ${chunk.name} 是 ${chunk.kb.toFixed(2)} KB，离预算只剩 ` +
            `${(actual * 100).toFixed(1)}%（至少要 5%）。` +
            `要么继续把只在触发后才出现的组件改成 lazy，要么连同理由一起上调预算。`
    );
});


test("katex 必须自己成块：不能混进 markdown 块", t => {
    // 2026-10-13 实测：markdown 块 345 KB 里 **234.9 KB（71%）是 katex**。
    // katex 只被 `utils/MathNode.tsx` 的 import("katex") 用到 —— 但 manualChunks 把
    // 它和 markdown-it 一起钉进了 "markdown" 块，于是**每打开一篇笔记都要下这 235 KB**，
    // 哪怕通篇没有一个公式（MathNode 那句动态 import 只在渲染公式时才跑，块却已经下来了）。
    //
    // 拆开后实测：打开记事本 JS 1218.7 → 965.2 KB（少 253 KB），请求 16 → 15；
    // 有公式的笔记仍然下得到（harness/katex-on-demand-probe.mjs 双向验过）。
    const assets = join(findProjectDir(), "dist", "client", "assets");
    let files: string[];
    try {
        files = readdirSync(assets);
    } catch {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    // ⚠️ 产物里会有**两个** katex 块：主应用一个、`mermaid-sandbox.html` 那个入口一个
    // （沙箱里画流程图也可能带公式）。所以这里用 some 而不是 find。
    const katexChunks = files.filter(f => /^katex-.*\.js$/.test(f));
    assert.ok(katexChunks.length > 0, "产物里没有独立的 katex-*.js 块 —— 它多半又被并进 markdown 块了");

    // katex 自己的源码里必有这条（错误提示里的品牌名），拿它当指纹比搜 "katex" 稳：
    // "katex" 这四个字母会出现在很多 import 路径与注释里，而 "KaTeX" 只来自它的源码。
    const MARKER = "KaTeX";
    assert.ok(
        katexChunks.some(f => readFileSync(join(assets, f), "utf-8").includes(MARKER)),
        `${katexChunks.join("、")} 里没有 KaTeX 的指纹，块的内容可能挪走了（换一个指纹）`
    );
    for (const f of files.filter(n => /^markdown(-|$).*\.js$/.test(n))) {
        assert.ok(
            !readFileSync(join(assets, f), "utf-8").includes(MARKER),
            `${f} 里混进了 katex（${MARKER}）—— 每篇笔记都会为此多下 235 KB。` +
                `去 vite.config.ts 把 katex 单独分流成块。`
        );
    }
});

test("记事本整块不许进首屏（hook 也不能）", t => {
    // 这条钉的是 2026-10-06 的一次疏漏：`NotesPage` 组件确实 lazy 了，
    // 但 App 顶层还调着 `useNotes()` —— **hooks 不能异步调用**，
    // 于是整个 hook（连带它的全部文案、乐观更新、回滚逻辑）都留在首屏包里。
    // 组件 lazy、hook 没 lazy，等于只 lazy 了一半。
    //
    // 正确做法：hook 与视图一起塞进 `NotesOverlay`，对这个文件做 lazy。
    const dir = findProjectDir();
    let appSrc: string;
    try {
        appSrc = readFileSync(join(dir, "src", "App.tsx"), "utf-8");
    } catch {
        t.skip("读不到 App.tsx，跳过");
        return;
    }
    assert.ok(
        !/import\s*\{[^}]*useNotes[^}]*\}\s*from\s*["'][^"']*useNotes["']/.test(appSrc),
        "App.tsx 又静态 import 了 useNotes —— 记事本的 hook 会被打进首屏包。" +
            "它只能通过 lazy 的 NotesOverlay 用（组件与 hook 必须一起懒加载）"
    );
    assert.ok(
        !/=\s*useNotes\s*\(/.test(appSrc),
        "App.tsx 顶层又调了 useNotes() —— hooks 不能异步调用，" +
            "这样整个 hook 都会留在首屏。挪进 NotesOverlay 组件里"
    );
    assert.ok(
        /NotesOverlay/.test(appSrc) && /lazy\s*\(\s*\(\)\s*=>\s*import\(["'][^"']*NotesOverlay["']\)/.test(appSrc),
        "App.tsx 应该是 lazy(() => import('./components/NotesOverlay'))"
    );
});

test("真实首屏里搜不到记事本的数据层 SQL", t => {
    // 双保险：上面那条管源码，这里管产物。
    // `INSERT INTO notes` 出现就说明 methods/notes.ts 被打进首屏了。
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    for (const f of fs.files) {
        if (!/\.js$/.test(f.name)) continue;
        const text = readFileSync(join(findProjectDir(), "dist", "client", "assets", f.name), "utf-8");
        assert.ok(!text.includes("cm-content") && !text.includes("cm-scroller"), `${f.name} 含 CodeMirror 编辑器代码，不能进入首屏`);
        assert.ok(
            !text.includes("INSERT INTO notes"),
            `${f.name} 里有 notes 表的 INSERT —— 记事本的数据层进首屏了`
        );
        assert.ok(
            !text.includes("加载记事本失败"),
            `${f.name} 里有 useNotes 的文案 —— hook 进首屏了（lazy 漏了一半？）`
        );
    }
});

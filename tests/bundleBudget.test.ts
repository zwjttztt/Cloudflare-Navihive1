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
//
// ⚠️ 2026-11-04（审查项 R15）：**门禁以前会在最该红的时候变绿。**
//    原来 `firstScreen()` 有两处静默降级：dist/client/index.html 读不到就 `return null`
//    （后面所有断言全跳），index.html 引用的资产读不到就 `catch { continue; }`（少算几个
//    文件、总和自然小）。于是「dist 根本没构建」和「dist 构建断了一半」都被报成绿。
//    现在改成两档：
//      · strict（`npm run check:budget`，或 NAVIHIVE_BUDGET_STRICT=1）：
//        **量不到就是不过** —— HTML 缺失 / 引用断裂 / 资产读不到一律 fail，不允许 skip；
//      · 非 strict（普通 `npm test`）：仍然可以跳过（单测不该强迫先 build 一遍），
//        但跳过**必须打印原因**，不再静默。
//    判据在 script/bundleBudgetGate.mjs（纯函数，由 tests/bundleBudgetGate.test.ts 钉住），
//    本文件只负责注入真 fs 和决定「跳过还是失败」。

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
    isStrictMode,
    strictModeSource,
    measureFirstScreen,
    decideBudgetGate,
    type FirstScreenMeasure,
} from "../script/bundleBudgetGate.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * strict 模式是不是开着。
 *
 * `npm run check:budget` 时 npm 会把 `npm_lifecycle_event=check:budget` 放进环境，
 * 而 script/unit-tests.mjs spawn node:test 时没有传 env，所以子进程继承得到。
 * 普通 `npm test` 两者都没有 → 非 strict。
 */
const STRICT = isStrictMode(process.env);
const STRICT_SOURCE = strictModeSource(process.env);

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

/**
 * 「量不到」的统一出口：strict 下必须 fail，非 strict 下可以 skip 但要留一句话。
 *
 * 为什么不给 strict 分支留任何 skip 的余地：这条门禁的全部价值就在于
 * 「dist 不在 / 引用断了」这件事必须有人喊出来。允许 skip，就等于允许
 * 「谁把 CI 里的 build 步骤弄坏了，谁就顺手把门禁静音」。
 *
 * @param t node:test 的测试上下文
 * @param reason 为什么量不到（一句话，直接可照做）
 */
function skipOrFail(t: TestContext, reason: string): void {
    if (STRICT) {
        assert.fail(
            `${reason}\n` +
                `⚠️ 当前是 strict 模式（由 ${STRICT_SOURCE} 打开）：体积门禁不允许跳过 —— 量不到就是不过。`
        );
    }
    // 非 strict 也不能静默：以前 t.skip 只写进 TAP 的 SKIP 行，滚屏里根本看不见
    console.log(`  ⏭  跳过：${reason}`);
    t.skip(reason);
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
//
// ⚠️ 2026-10-28 批次二（性能 / 数据层）：258 → 261。
// 实测 247.30 KB，按 258 算只剩 4.33%，跌破 5% 线。这一批进首屏的是：
//   · `hooks/useNotes.ts` 的**轮询变更指纹**逻辑（约 1.4 KB）—— 后台同步轮询本来就在
//     首屏常驻跑（首页挂载即启动），指纹只是把「每轮倒整份快照」换成「先问有没有变」，
//     这段判定必须在首屏里，不能 lazy（lazy 等于「轮询逻辑加载完之前先崩一轮」）。
//   · `client.ts` 的附件慢端点判定 + `clientMethods/notes.ts` / `mock.ts` 的分页改造
//     （合计约 0.6 KB）—— 列表首拉本来就要走，分页逻辑必须同源。
// 关于那条「合并 ErrorBoundary」的刀：评估过，**它最多省一份副本（约 1.4 KB minified），
// 盖不住这 2 KB**，而且是对白屏兜底路径的重构 —— 一旦合错，整站渲染异常就失去最后一道
// 屏障，不该塞进这个性能批次。所以这次走「连同理由一起上调预算」这条测试本身允许的响应，
// 余量回到 5.5%（与批次一落定时的 5.2% 持平）。真要再腾空间，正确的刀仍是上面那个合并，
// 但它值得单独成一轮、配齐回归，而不是跟性能批次绑在一起赶。
// ⚠️ 2026-10-29 P0-1（加载失败被渲染成「空数据」）：261 → 264。
// 实测 index 248.5 → 250.01 KB（+1.49 KB，esbuild 单独量过那个组件是 1522 字节）。
// 进首屏的是 `components/SiteListErrorState.tsx`（加载失败面板：一行标题 + 失败原因 +
// 一句「数据没丢」+ 重试按钮）。**它必须常驻**，不能像弹窗那样 lazy ——
// 它出现的场合恰恰是「请求没成功」，这时候再去下载一个 chunk，等于让错误提示也跟着
// 转圈、而且大概率同样下载失败（这正是它要治的那种故障）。
// 也是因此这次只能抬预算：抬之前 index 已经是 248.5 KB，离 5% 线（248.57 KB）
// 只剩 0.1 KB —— 也就是说这道门禁当时已经贴线，任何一点首屏代码都会让它红，
// 而这次进来的是「用户分不清『数据没了』和『没取到』」这条 P0。
// 真要继续腾空间，刀在旧账上：RenderBoundary 与根上的 ErrorBoundary 是两份
// 各自带内联样式的实现（历史记录里就写着「合并能省约 1.3 KB」），但它动的是白屏兜底
// 路径，该单独成一轮、配齐回归，不该塞进这个 bugfix 批次。
// ⚠️ 264 → 266（离线队列总字节上限）：实测 index 250.95 → 251.49 KB（+0.54 KB）。
// 264 是按 chunk 自身算 5% 余量的（(264-250.95)/250.95 = 5.20%），251.49 时只剩
// (264-251.49)/251.49 = **4.98%** —— 差 0.06 KB 跌破线。这批进首屏的是
// `API/offlineQueue.ts` 里的东西：`OfflineQueueFullError`（含那句给用户看的文案）、
// 总量求和与两道闸门分支，外加 `useSiteCreator` 里两个 instanceof 分支。
// **它们 lazy 不了**：入队闸门跑在「离线写操作失败的那一刻」，那时再去下载一个 chunk
// 既来不及（写操作已经发生）也会同样失败（离线）。而原来的 5.20% 本就是贴线的
// —— 与上面 P0-1 那次同一个处境：任何一点首屏代码都会让这条红。
// 抬到 266 后余量 5.77%，「谁再往首屏塞东西」这个信号照旧抓得住。
// 真要腾这 0.5 KB，正确的刀还是上面那条「合并 ErrorBoundary」（约 1.3 KB），
// 同样该单独成一轮、配齐回归。
// ⚠️ 266 → 270（2026-11-03，C6：429 倒计时 + 离线队列跨标签页锁）。
// 实测 index 253.16 → **255.67 KB**（+2.51 KB），两笔都 lazy 不了：
//   · `API/client.ts` 的 429 分支与 `parseRetryAfter`、`API/offlineQueue.ts` 的
//     Web Locks / 租约协调（合计约 1.73 KB）—— 前者跑在「任何请求被限流」那一刻，
//     后者跑在「联网要重放队列」那一刻，**都是故障路径**：那时再去下载 chunk
//     既来不及也会同样失败（与上面 P0-1、离线队列上限那两次同一个处境）；
//   · `components/RateLimitBanner.tsx`（约 0.78 KB，含 MUI Alert 的整块实测成本）——
//     它必须常驻挂载才接得住事件，改成 lazy 只会把「下载 chunk」加进首屏（多一个请求）。
// 顺带记一笔：改之前基线 250.01 就已经过期 2.9 KB（实测 253.16），只因为落在 5%
// 漂移容差内没人发现 —— 也就是说余量本已只剩 5.07%，又是贴线状态。
// 抬到 270 后余量 5.60%，「谁再往首屏塞东西」这个信号照旧抓得住。
// 真要腾这 2 KB，刀还是那两条旧账：合并 RenderBoundary 与根 ErrorBoundary（约 1.3 KB）、
// 再把 `clientMethods/*` 里首屏用不到的方法拆一轮 —— 都该单独成一轮、配齐回归。
//
// ⚠️ 2026-11-08 白块/抖动修复（P0 用户实测，8 张截图）：270 → 272。
// 这批进首屏的是修复本身的必需逻辑，且**没有可改 lazy 的赘肉**（逐项核过）：
//   · `useSites.ts` 请求序号 + in-flight 去重 + 结构共享合并（`mergeGroupsPreservingRefs`，
//     纯函数，被首屏的 `applyRemoteData` 同步调用，无法推到懒块）—— 这是掐上游去重的主修；
//   · `App.tsx` 笔记打开时背景停绘的 `html[data-notes-open]` effect、拆共享 `ChunkBoundary`、
//     `NOTES_LOADING_FALLBACK` 稳定常量（纯注释级 + 小常量，无新依赖）；
//   · `GroupCard.tsx` / `SiteCard.tsx` / `index.css` 的渲染层修复（占位高度固定、hover 收敛、
//     入场动画一次性标记、停绘规则）—— 全是首屏常驻组件的就地修法，不是新组件。
// 基线 255.67（→ 实测 258.23）离 5% 红线（257.14 KB）本来就只剩 1.47 KB，这批 P0 必需逻辑
// 约 +2.56 KB 直接顶破；实测 index 258.23 KB，按 272 算余量 5.34%，信号照旧抓得住。
// （顺带排除「构建漂移」：本仓 2026-10-14 记录过未改代码 rebuild 涨 1.19 KB 的同类漂移，
//  即使含部分漂移，可懒加载的赘肉也无处可砍，故按 P0 例外照实抬预算。）
const BUDGET_KB = 272;
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
// 250.01 —— 2026-10-29 P0-1：加载失败面板（SiteListErrorState）进首屏，见上面预算那段。
// 这是「为了修一个 P0 而必须付的首屏成本」，不是悄悄涨上来的：抬预算的理由与实测字节
// 都写在 BUDGET_KB 上面那几行，改这条基线时请连着那段一起读。
//
// 255.67 —— 2026-11-03 C6：429 倒计时与离线队列跨标签页锁进首屏（+2.51 KB），
// 理由同上那段。两者都在故障路径上，lazy 反而更糟。
//
// 258.23 —— 2026-11-08 白块/抖动修复（P0，见 BUDGET_KB 上方那段）：首屏必需逻辑约 +2.56 KB，
// 已逐项确认无可改 lazy 的赘肉，按 P0 例外照实更新基线，不靠放宽过门禁。
const BASELINE_KB = 258.23;

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
/**
 * ⚠️ 2026-11-05 曾因 `> [!COPY]` 可复制块的样式把 gzip 从 300 抬到 301。
 * v31 之后复制能力整体移除（渲染层组件、CSS 规则、工具栏入口全删），
 * 那 0.6 KB gzip 已还回来了 —— 预算**还原到 300**，重新留出 5% 余量。
 * 🔴 下一次要抬这个常量，仍按上面那条规矩：先还债或改懒加载，不许靠放宽过门禁。
 */
const FIRST_SCREEN_BUDGET_RAW_KB = 920;
// ⚠️ 2026-11-07（v33.0.3，第三批 T01–T04）上调 300 → 301：不是代码进场，是依赖涨幅。
// 基线上一次钉在 283.2（2026-11-02，27.0.0）。之后 v28→v33.0.2 历次 MUI 9.x / React /
// 依赖 minor·patch 升级把首屏 gzip 推到 285.8（实测构成：mui-core 95.4 + index 84.2 +
// react 62.5 + vendor 35.8 + css 6.3 + preload 1.5）。index 应用块只从 255.67 微涨到
// 256.7，几乎没有应用代码进场 —— 说明这是「依赖涨价」而非「组件被改回同步 import」，
// 与 2026-10-11 / v31 那几次同性质。抬到 301 后余量回到 5.3%，「谁再往首屏塞东西」
// 这个信号照样抓得住。
// 🔴 第三批 T01–T04 全部是后端 + CI 改动（note_revision 节流 / 批量删除 partial /
// 离线队列重放守卫 / docker-publish SBOM·签名·扫描），**零前端改动**，所以这次涨价与
// 本批无关：本批只是把已经贴线的预算重定回安全线，不是为本批放行。
const FIRST_SCREEN_BUDGET_GZIP_KB = 301;
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
 *
 * 858.5 / 283.2 —— 2026-11-02（27.0.0，D5）**照实下调**，不是口径变化：
 *   根因是 `vite.config.ts` 的 `scanFirstScreenMui()` 跟着 `import type` 走，
 *   把整棵懒加载弹窗树专用的 MUI 判成「首屏要用」并归进 mui-core，让
 *   index.html 的 modulepreload 白预下载了约 30 KB。修法是让扫描器只看值绑定
 *   （详见该文件里 STATIC_IMPORT_RE / clauseNames 上的注释）。运行时没有任何
 *   模块被挪走，产物结构也没变，所以这是**真实回收**而非指标美化。
 *   余量因此从 3.5% / 3.0% 回到 7.2% / 5.9%，后续 C5/D1 等首屏项有了空间。
 */
// 实测基线（2026-11-07，v33.0.3）：867.6 KB 原始 / 285.8 KB gzip。
// 自 27.0.0（852.4 / 280.1 → 858.5 / 283.2）之后，v28→v33.0.2 的依赖升级把 gzip 推到
// 285.8；index 应用块仅 256.7（vs 255.67 基线）几乎未涨，确认是依赖而非代码进场。
const FIRST_SCREEN_BASELINE_RAW_KB = 867.6;
const FIRST_SCREEN_BASELINE_GZIP_KB = 285.8;

/** 首屏测量结果的别名（字段形状由 script/bundleBudgetGate.mjs 定义，这里不重复声明） */
type FirstScreen = FirstScreenMeasure;

/**
 * 量一次真实首屏（注入真 fs）。
 *
 * 不再返回 null：缺 HTML / 缺资产都如实记录在返回值里，由 decideBudgetGate
 * （内部走 firstScreenProblem）翻译成「量不了，为什么」，再由调用方决定跳过还是失败。
 * 以前 `return null` / `catch { continue; }` 这两处把「量不到」变成了「量得小」。
 */
function firstScreen(): FirstScreen {
    const dir = findProjectDir();
    let html: string | null;
    try {
        html = readFileSync(join(dir, "dist", "client", "index.html"), "utf-8");
    } catch {
        html = null;
    }
    return measureFirstScreen({
        html,
        readAsset: (name: string) => {
            try {
                return readFileSync(join(dir, "dist", "client", "assets", name));
            } catch {
                return null;
            }
        },
    });
}

/** 首屏量不全时的失败/跳过（四条用例共用，省得每处各写一遍分支） */
function requireFirstScreen(t: TestContext): FirstScreen | null {
    const measure = firstScreen();
    // 「该 fail 还是该 skip」只由 decideBudgetGate 判 —— 它是纯函数，
    // 四分环境组合 × 三种量不到的情形都由 tests/bundleBudgetGate.test.ts 钉着。
    const verdict = decideBudgetGate(measure, process.env);
    if (verdict.action === "measure") return measure;
    if (verdict.action === "fail") {
        assert.fail(
            `${verdict.reason}\n` +
                `⚠️ 当前是 strict 模式（由 ${verdict.strictSource} 打开）：体积门禁不允许跳过 —— 量不到就是不过。`
        );
    }
    console.log(`  ⏭  跳过：${verdict.reason}`);
    t.skip(verdict.reason ?? "没有构建产物");
    return null;
}

test("真实首屏（index.html 的 script + modulepreload + css 合计）不超预算", t => {
    const fs = requireFirstScreen(t);
    if (!fs) return;
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
// 实际断言是 3%，报告上「还有 5% 余量」是假的。当时如实改回 3%，并在这里立下约定：
// 真把首屏压下来之后，把断言和标题一起改回 0.05（同一处改，别只改一个）。
//
// ✅ 2026-11-02 达成（27.0.0）：实测 raw 858.7 KB / gzip 283.4 KB，余量 7.1% / 5.9%，
// 5% 线（raw 876.2 KB / gzip 285.7 KB）是真跨过去了，不是靠抬预算把数字做漂亮。
// 降掉的 29.9 KB / 7.8 KB 来自 mui-core 里的一批**白背**：扫描器顺着
// `import type { NavCenterPanelId } from "./components/navigationCenter/model"`、
// `import type { CommandItem } from "./CommandPalette"` 这类**类型导入**走进了整棵
// 懒加载弹窗树，把弹窗专用的 Alert / Dialog / Switch / LinearProgress /
// FormControlLabel 和 12 个 icons-material 判成「首屏要用」，归进 mui-core 后被
// index.html 的 modulepreload 一起预下载 —— 而运行时那几条边根本不存在。
// 修在 vite.config.ts 的 STATIC_IMPORT_RE / clauseNames（不再跟类型导入）。
test("**当前**真实首屏也要留 5% 余量，不只是基线留", t => {
    // 和上面那条 index chunk 的余量用例同一个道理：基线只在真把首屏压下来时才更新，
    // 中间加进去的几 KB 它看不见。真正该红的是「现在离上限还有多远」。
    const fs = requireFirstScreen(t);
    if (!fs) return;
    const rawHeadroom = (FIRST_SCREEN_BUDGET_RAW_KB - fs.rawKb) / fs.rawKb;
    const gzipHeadroom = (FIRST_SCREEN_BUDGET_GZIP_KB - fs.gzipKb) / fs.gzipKb;
    assert.ok(
        rawHeadroom >= 0.05 && gzipHeadroom >= 0.05,
        `当前真实首屏 ${fs.rawKb.toFixed(1)} KB / gzip ${fs.gzipKb.toFixed(1)} KB，` +
            `离预算只剩 ${(rawHeadroom * 100).toFixed(1)}% / ${(gzipHeadroom * 100).toFixed(1)}%` +
            `（各留至少 5% —— 见本用例上方的注释）。`
    );
});

test("首屏预算的基线常量要与实测相符（别让基线悄悄过期）", t => {
    const fs = requireFirstScreen(t);
    if (!fs) return;
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
    const fs = requireFirstScreen(t);
    if (!fs) return;
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
        skipOrFail(
            t,
            "dist/client/assets 下找不到 index-*.js —— 先 npm run build（体积门禁要有构建产物才能量）"
        );
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
        skipOrFail(
            t,
            "dist/client/assets 下找不到 index-*.js —— 先 npm run build（体积门禁要有构建产物才能量）"
        );
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
        skipOrFail(
            t,
            "dist/client/assets 不存在 —— 先 npm run build（katex 分块只能在产物上验证）"
        );
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
        // 这条读的是源码不是产物：读不到意味着仓库本身不完整（或项目根目录探错了）,
        // 不是「还没 build」。strict 下必须红 —— 否则「删掉 App.tsx」等于删掉这条门禁。
        skipOrFail(t, "读不到 src/App.tsx —— 仓库不完整或项目根目录探错了，先确认工作区");
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
    const fs = requireFirstScreen(t);
    if (!fs) return;
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

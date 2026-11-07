// tests/useSites.dom.test.tsx
// 数据层 hook：bootstrap 落地、站点按分组归堆、本地写。
//
// 为什么补它：这块原来是 App 里最「牵一发动全身」的一段，抽出来之后却一条直测都没有。
// 而这里三条规矩写反了都不报错，只是**界面慢慢变得不对**：
//   1. **错误提示只在非 silent 时给** —— 后台静默刷新失败也弹提示的话，
//      用户每隔一会儿就被一条「加载失败」打断，而界面上的数据其实是好的；
//   2. **只有认证类失败才踢回登录页** —— 网络抖动也踢的话，地铁里刷一下就被登出；
//   3. **站点按 order_num 排序归堆 + 过滤掉没有 id 的分组** ——
//      顺序错了是「卡片位置乱跳」，没 id 的分组混进来是「排序保存时炸在后端」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSites, type UseSitesDeps } from "../src/hooks/useSites";
import type { BootstrapData, Site } from "../src/API/http";
// 认证失败的判据是 ApiError 的 code / status（见 src/API/apiError.ts 的 isAuthError），
// mock 抛的必须是真 ApiError —— 拿 new Error("认证已过期") 喂进去测的是注释，不是代码。
import { API_ERROR_CODES, ApiError } from "../src/API/apiError";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Log {
    errors: string[];
    authFail: number;
    extras: BootstrapData[];
}

interface Options {
    /** bootstrap 的结果；是个函数的话每次调用返回它的返回值 */
    bootstrap?: BootstrapData | (() => Promise<BootstrapData>);
}

function makeDeps(log: Log, o: Options): UseSitesDeps {
    return {
        api: {
            bootstrap: async () =>
                typeof o.bootstrap === "function"
                    ? await o.bootstrap()
                    : ((o.bootstrap ?? { groups: [], sites: [], configs: {} }) as BootstrapData),
        },
        onRemoteExtras: data => void log.extras.push(data),
        onError: msg => void log.errors.push(msg),
        onAuthFail: () => void log.authFail++,
    };
}

/** 把 hook 的状态与操作挂到 DOM 上，方便在 jsdom 里驱动 */
let api: ReturnType<typeof useSites> | null = null;

function Harness({ deps }: { deps: UseSitesDeps }) {
    const s = useSites(deps);
    const [tag] = useState(0); // 只为触发一次渲染，无他用
    void tag;
    api = s;
    return (
        <div>
            <span data-testid="loading">{String(s.loading)}</span>
            <span data-testid="error">{s.error ?? ""}</span>
            <span data-testid="groups">
                {JSON.stringify(
                    s.groups.map(g => ({ id: g.id, sites: g.sites.map((x: Site) => x.id) }))
                )}
            </span>
        </div>
    );
}

function mount(deps: UseSitesDeps) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness deps={deps} />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    api = null;
    document.body.innerHTML = "";
}

const text = (id: string) =>
    (document.querySelector(`[data-testid="${id}"]`)?.textContent || "").trim();

async function run(fn: () => Promise<unknown> | void) {
    await act(async () => {
        await fn();
    });
}

const site = (id: number, groupId: number, order: number): Site =>
    ({ id, group_id: groupId, name: `s${id}`, url: `https://${id}.example`, order_num: order } as Site);

const grp = (id: number | undefined, name: string) => ({ id, name, order_num: id ?? 0 });

// ---------------- 初始状态 ----------------

test("初始：loading 为 true、无错误、无分组", t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    mount(makeDeps(log, {}));
    assert.equal(text("loading"), "true");
    assert.equal(text("error"), "");
    assert.equal(text("groups"), "[]");
});

// ---------------- bootstrap 落地 ----------------

test("站点按 order_num 归到各自分组下（顺序错了界面上就是卡片乱跳）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    const data: BootstrapData = {
        groups: [grp(1, "常用"), grp(2, "工具")] as BootstrapData["groups"],
        sites: [site(30, 1, 3), site(10, 1, 1), site(20, 1, 2), site(40, 2, 1)],
        configs: {},
    } as BootstrapData;
    mount(makeDeps(log, { bootstrap: data }));
    await run(() => api!.fetchData());

    assert.deepEqual(JSON.parse(text("groups")), [
        { id: 1, sites: [10, 20, 30] },
        { id: 2, sites: [40] },
    ]);
    assert.equal(text("loading"), "false");
});

test("没有 id 的分组直接丢掉（留着会在排序保存时炸在后端）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    const data = {
        groups: [grp(undefined, "幽灵"), grp(1, "常用")],
        sites: [site(10, 1, 1)],
        configs: {},
    } as unknown as BootstrapData;
    mount(makeDeps(log, { bootstrap: data }));
    await run(() => api!.fetchData());
    assert.deepEqual(JSON.parse(text("groups")), [{ id: 1, sites: [10] }]);
});

test("配置 / 偏好这类「别的 App 层状态」交回给 onRemoteExtras，本 hook 不自己吞", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    const data = { groups: [], sites: [], configs: { "site.title": "T" } } as BootstrapData;
    mount(makeDeps(log, { bootstrap: data }));
    await run(() => api!.fetchData());
    assert.equal(log.extras.length, 1, "应回调一次 onRemoteExtras");
    assert.equal(log.extras[0]!.configs?.["site.title"], "T");
});

// ---------------- 失败处理 ----------------

test("普通失败：给错误提示，但不踢回登录页", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    mount(
        makeDeps(log, {
            bootstrap: async () => {
                throw new Error("网络不通");
            },
        })
    );
    await run(() => api!.fetchData());
    assert.ok(log.errors.some(e => e.includes("加载数据失败")), `实际 ${JSON.stringify(log.errors)}`);
    assert.equal(log.authFail, 0, "网络抖动不能把人踢出去");
    assert.equal(text("loading"), "false", "失败了也要把 loading 收掉，否则一直转圈");
});

test("认证失败（401）：除提示外还要把登录态置为需要登录", async t => {
    t.after(cleanup);
    const cases = [
        // 迁移后的正常形状：code 是 unauthenticated
        new ApiError({ status: 401, code: API_ERROR_CODES.unauthenticated, message: "认证已过期" }),
        // 老形状（body 不是 JSON / 只有 {message}）：解析不出 code，靠 HTTP 401 兜底
        new ApiError({ status: 401, code: "unknown", message: "API错误: 401" }),
        // 账号被停用（403 forbidden）：同样要回登录页，否则用户对着空白页无路可走
        new ApiError({ status: 403, code: API_ERROR_CODES.forbidden, message: "账号已停用" }),
    ];
    for (const err of cases) {
        const log: Log = { errors: [], authFail: 0, extras: [] };
        cleanup();
        mount(
            makeDeps(log, {
                bootstrap: async () => {
                    throw err;
                },
            })
        );
        await run(() => api!.fetchData());
        assert.equal(log.authFail, 1, `「${err.code}」应触发一次 onAuthFail`);
    }
});

test("静默刷新失败：不弹提示、也不动 loading（后台刷新不该打断用户）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    mount(
        makeDeps(log, {
            bootstrap: async () => {
                throw new Error("网络不通");
            },
        })
    );
    await run(() => api!.fetchData({ silent: true }));
    assert.deepEqual(log.errors, [], "静默失败不该弹提示");
    assert.equal(text("loading"), "true", "静默刷新不该把 loading 打开（界面本来是好的）");
});

test("fetchData 的返回值能用来判断这次到底成功了没有", async t => {
    t.after(cleanup);
    const ok: Log = { errors: [], authFail: 0, extras: [] };
    mount(makeDeps(ok, { bootstrap: { groups: [], sites: [], configs: {} } }));
    let result: boolean | undefined;
    await run(async () => {
        result = await api!.fetchData();
    });
    assert.equal(result, true);
    cleanup();

    const bad: Log = { errors: [], authFail: 0, extras: [] };
    mount(
        makeDeps(bad, {
            bootstrap: async () => {
                throw new Error("boom");
            },
        })
    );
    await run(async () => {
        result = await api!.fetchData();
    });
    assert.equal(result, false);
});

// ---------------- 本地写 ----------------

test("本地 upsert：新卡片进对应分组，已有卡片原地更新", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    const data = {
        groups: [grp(1, "常用")],
        sites: [site(10, 1, 1)],
        configs: {},
    } as unknown as BootstrapData;
    mount(makeDeps(log, { bootstrap: data }));
    await run(() => api!.fetchData());

    await run(() => api!.upsertSiteLocally(site(11, 1, 2)));
    assert.deepEqual(JSON.parse(text("groups")), [{ id: 1, sites: [10, 11] }]);

    await run(() => api!.upsertSiteLocally({ ...site(10, 1, 1), name: "改过名" } as Site));
    const groups = JSON.parse(text("groups")) as Array<{ id: number; sites: number[] }>;
    assert.deepEqual(groups, [{ id: 1, sites: [10, 11] }], "更新已存在的卡片不该多出一条");
});

test("本地删除：单个与批量都只动本机状态（网络与回滚由调用方负责）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    const data = {
        groups: [grp(1, "常用")],
        sites: [site(10, 1, 1), site(11, 1, 2), site(12, 1, 3)],
        configs: {},
    } as unknown as BootstrapData;
    mount(makeDeps(log, { bootstrap: data }));
    await run(() => api!.fetchData());

    await run(() => api!.removeSiteLocally(11));
    assert.deepEqual(JSON.parse(text("groups")), [{ id: 1, sites: [10, 12] }]);

    await run(() => api!.removeSitesLocally([10, 12]));
    assert.deepEqual(JSON.parse(text("groups")), [{ id: 1, sites: [] }]);
});

test("批量写回（撤销多选删除时一次插回一整批）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    mount(makeDeps(log, { bootstrap: { groups: [grp(1, "常用")], sites: [], configs: {} } as unknown as BootstrapData }));
    await run(() => api!.fetchData());

    await run(() => api!.upsertSitesLocally([site(10, 1, 1), site(11, 1, 2), site(12, 1, 3)]));
    assert.deepEqual(JSON.parse(text("groups")), [{ id: 1, sites: [10, 11, 12] }]);
});

test("空数组的批量写回直接跳过（省一次 state 更新、也就省一轮卡片重渲染）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    mount(makeDeps(log, { bootstrap: { groups: [], sites: [], configs: {} } }));
    await run(() => api!.fetchData());
    const before = text("groups");
    await run(() => api!.upsertSitesLocally([]));
    assert.equal(text("groups"), before);
});

// ---------------- 请求序号 / in-flight 去重 / 结构共享 ----------------
// 这一组钉的是用户实测「分组计数 9↔10 反复跳、卡片时隐时现」的根因：
// 挂载期 4+ 条自动刷新源交错落地，晚到的旧快照覆盖先到的新快照，
// 且每次 bootstrap 都无条件 setGroups(全量新数组) 把整棵树白重渲染一遍。

test("只接受最新响应：先发后到的旧快照不得覆盖后发先到的新快照", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    const pending: Array<(data: BootstrapData) => void> = [];
    let calls = 0;
    const snapshot = (count: number): BootstrapData =>
        ({
            groups: [grp(1, "常用")],
            sites: Array.from({ length: count }, (_, i) => site(i + 1, 1, i + 1)),
            configs: {},
        } as unknown as BootstrapData);
    mount(
        makeDeps(log, {
            bootstrap: () =>
                new Promise<BootstrapData>(resolve => {
                    calls += 1;
                    pending.push(resolve);
                }),
        })
    );

    let older: Promise<boolean> = Promise.resolve(false);
    let newer: Promise<boolean> = Promise.resolve(false);
    await run(() => {
        // 第一个请求：故意让它最后才回来，且带的是**旧**快照（9 张）
        older = api!.fetchData({ silent: true });
        // force 发第二个请求：序号前进，第一个响应从此过期
        newer = api!.fetchData({ silent: true, force: true });
    });
    assert.equal(calls, 2, "force 应当真的发出第二个 bootstrap 请求");
    assert.equal(pending.length, 2, "应当有两个可控响应");

    // 新快照（10 张）先到并落地
    await run(async () => {
        pending[1]!(snapshot(10));
        await newer;
    });
    const afterNew = JSON.parse(text("groups")) as Array<{ sites: number[] }>;
    assert.equal(afterNew[0]!.sites.length, 10, "新快照先到要先落地");

    // 旧快照（9 张）后到：必须整个丢弃，连 onRemoteExtras 都不该回调
    const extrasBefore = log.extras.length;
    await run(async () => {
        pending[0]!(snapshot(9));
        await older;
    });
    const afterOld = JSON.parse(text("groups")) as Array<{ sites: number[] }>;
    assert.equal(
        afterOld[0]!.sites.length,
        10,
        "晚到的旧快照覆盖了新快照 —— 界面上就是计数 9↔10 反复跳"
    );
    assert.equal(
        log.extras.length,
        extrasBefore,
        "过期响应不该再回调 onRemoteExtras（那会重建 appConfigValue、带动整树重渲染）"
    );
});

test("连续两次内容相同的刷新：groups 引用保持不变（结构共享）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    // 每次调用都重新构造一份对象：模拟服务端每次解析出的全新 JSON
    const fresh = (): BootstrapData =>
        ({
            groups: [{ id: 1, name: "常用", order_num: 0 }],
            sites: [site(10, 1, 1), site(11, 1, 2)],
            configs: {},
        } as unknown as BootstrapData);
    mount(makeDeps(log, { bootstrap: async () => fresh() }));

    await run(() => api!.fetchData({ silent: true }));
    const before = api!.groups;
    assert.equal(before.length, 1);

    await run(() => api!.fetchData({ silent: true }));
    assert.strictEqual(
        api!.groups,
        before,
        "内容没变还换了 groups 数组引用，被 memo 的 GroupCard 会整片白重渲染"
    );
    assert.strictEqual(
        api!.groups[0],
        before[0],
        "未变化的分组对象也要沿用旧引用，否则等于没做结构共享"
    );
    assert.deepEqual(JSON.parse(text("groups")), [{ id: 1, sites: [10, 11] }]);
});

test("同一时刻并发调用只发出 1 个 api.bootstrap()（in-flight 去重）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    let calls = 0;
    let release: (data: BootstrapData) => void = () => {};
    mount(
        makeDeps(log, {
            bootstrap: () =>
                new Promise<BootstrapData>(resolve => {
                    calls += 1;
                    release = resolve;
                }),
        })
    );

    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(true);
    await run(() => {
        first = api!.fetchData({ silent: true });
        second = api!.fetchData({ silent: true });
    });
    assert.equal(calls, 1, "并发调用不能各发各的请求");
    assert.strictEqual(first, second, "并发调用必须复用同一个 Promise 对象");

    await run(async () => {
        release({ groups: [], sites: [], configs: {} } as BootstrapData);
        await first;
    });
    assert.equal(calls, 1, "复用期间后续也不该补发请求");
});

test("fetchData / applyRemoteData 引用稳定（P2-13 无回归）", async t => {
    t.after(cleanup);
    const log: Log = { errors: [], authFail: 0, extras: [] };
    const data = {
        groups: [grp(1, "常用")],
        sites: [site(10, 1, 1)],
        configs: {},
    } as unknown as BootstrapData;
    mount(makeDeps(log, { bootstrap: data }));

    const fetchRef = api!.fetchData;
    const applyRef = api!.applyRemoteData;
    await run(() => api!.fetchData({ silent: true }));
    assert.strictEqual(api!.fetchData, fetchRef, "fetchData 不该随渲染重建");
    assert.strictEqual(api!.applyRemoteData, applyRef, "applyRemoteData 不该随渲染重建");

    // 状态真的变了之后也要稳定（下游把它放进 useMemo 依赖才不会每次失效）
    await run(() => api!.upsertSiteLocally({ ...site(10, 1, 1), name: "改过名" } as Site));
    assert.strictEqual(api!.fetchData, fetchRef, "状态更新后 fetchData 仍是同一引用");
});

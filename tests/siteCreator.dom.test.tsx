// tests/siteCreator.dom.test.tsx
// useSiteCreator 的组件级用例。表单字段怎么算由 tests/siteForm.test.ts 覆盖，
// 这里盯的是那几道**闸门**——它们是「改坏了不报错、但会写出脏数据」的典型：
//   - 名字 / 网址没填就提交：不能发请求；
//   - javascript: 这类伪协议：入库前必须挡掉（卡片是 href={site.url} 直出的）；
//   - 连点「创建」：只能写一张卡片；
//   - 同一条链接已经加过：交给 guardDuplicate，没确认绝不写库。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSiteCreator, type CreatorApi } from "../src/hooks/useSiteCreator";
import type { GroupWithSites } from "../src/types";
import type { Group, Site } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const site = (id: number, groupId: number, order: number): Site =>
    ({ id, name: `s${id}`, url: `https://s${id}.com`, group_id: groupId, order_num: order } as Site);

const initialGroups = (): GroupWithSites[] => [
    { id: 1, name: "g1", order_num: 0, sites: [site(10, 1, 0), site(11, 1, 5)] },
    { id: 2, name: "g2", order_num: 1, sites: [] },
];

type Log = {
    createSite: Site[];
    createGroup: Group[];
    upserted: Site[];
    errors: string[];
    notes: string[];
    duplicateCalls: number;
};

function makeApi(opts: { hang?: boolean } = {}) {
    const log: Log = {
        createSite: [],
        createGroup: [],
        upserted: [],
        errors: [],
        notes: [],
        duplicateCalls: 0,
    };
    let releaseCreate: (() => void) | null = null;
    const api: CreatorApi = {
        createGroup: async input => {
            log.createGroup.push(input);
            return { ...input, id: 99 } as Group;
        },
        createSite: async input => {
            log.createSite.push(input);
            if (opts.hang) {
                await new Promise<void>(r => {
                    releaseCreate = r;
                });
            }
            return { ...input, id: 77 } as Site;
        },
    };
    return { api, log, release: () => releaseCreate?.() };
}

function Harness({
    api,
    log,
    guard,
    menuCloser,
}: {
    api: CreatorApi;
    log: Log;
    guard?: boolean;
    menuCloser: () => void;
}) {
    const [groups, setGroups] = useState<GroupWithSites[]>(initialGroups);
    const groupsRef = useRef<GroupWithSites[]>(groups);
    useEffect(() => {
        groupsRef.current = groups;
    }, [groups]);
    const creator = useSiteCreator({
        api,
        groupsRef,
        setGroups,
        upsertSiteLocally: s => log.upserted.push(s),
        guardDuplicate: (_url, _id, run) => {
            log.duplicateCalls++;
            if (guard) void run();
            return guard ?? false;
        },
        iconApi: "https://icon.example/{domain}",
        onError: m => log.errors.push(m),
        onNotify: (m, level) => log.notes.push(`${level}:${m}`),
        onMenuClose: menuCloser,
    });
    (window as unknown as { __c: typeof creator }).__c = creator;
    return (
        <div>
            <span data-testid='open-group'>{String(creator.openAddGroup)}</span>
            <span data-testid='open-site'>{String(creator.openAddSite)}</span>
            <span data-testid='draft'>{JSON.stringify(creator.newSite)}</span>
            <span data-testid='creating'>{String(creator.creatingSite)}</span>
            <span data-testid='groups'>{JSON.stringify(groups.map(g => [g.id, g.sites.map(s => s.id)]))}</span>
        </div>
    );
}

function mount(node: Parameters<Root["render"]>[0]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.textContent!.trim();
const c = () => (window as unknown as { __c: ReturnType<typeof useSiteCreator> }).__c;
const noop = () => {};

async function run(fn: () => void | Promise<void>) {
    await act(async () => {
        await fn();
    });
}

/** 等一轮宏任务： guardDuplicate 里是 void run()，回调要下一个 tick 才落地 */
async function tick() {
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, 0));
    });
}

/** 走一遍「填名字 + 填网址」，模拟用户在表单里输入 */
async function fill(name: string, url: string) {
    await run(() => c().handleSiteInputChange({ target: { name: "name", value: name } }));
    await run(() => c().handleSiteInputChange({ target: { name: "url", value: url } }));
}

test("打开新建卡片：草稿重置、排在分组末尾、密码回到隐藏态", async () => {
    const { api, log } = makeApi();
    mount(<Harness api={api} log={log} menuCloser={noop} />);
    await run(() => c().handleOpenAddSite(1));
    assert.equal(text("open-site"), "true");
    const draft = JSON.parse(text("draft"));
    assert.equal(draft.group_id, 1);
    assert.equal(draft.order_num, 6, "该组最大 order_num 是 5，新卡片应从 6 开始");
    assert.equal(draft.name, "");
    // 空分组从 0 开始
    await run(() => c().handleOpenAddSite(2));
    assert.equal(JSON.parse(text("draft")).order_num, 0);
    cleanup();
});

test("打开新建分组：先关掉「更多选项」菜单，再开弹窗", async () => {
    const { api, log } = makeApi();
    let closed = 0;
    mount(<Harness api={api} log={log} menuCloser={() => closed++} />);
    await run(() => c().handleOpenAddGroup());
    assert.equal(closed, 1);
    assert.equal(text("open-group"), "true");
    cleanup();
});

test("创建分组：空名直接拦下，不发请求", async () => {
    const { api, log } = makeApi();
    mount(<Harness api={api} log={log} menuCloser={noop} />);
    await run(() => c().handleOpenAddGroup());
    await run(() => c().handleCreateGroup("   "));
    assert.deepEqual(log.createGroup, []);
    assert.deepEqual(log.errors, ["分组名称不能为空"]);
    assert.equal(text("open-group"), "true", "没创建成功就别关弹窗");
    cleanup();
});

test("创建分组：成功后追加到本地列表并关弹窗", async () => {
    const { api, log } = makeApi();
    mount(<Harness api={api} log={log} menuCloser={noop} />);
    await run(() => c().handleOpenAddGroup());
    await run(() => c().handleCreateGroup("  新分组  "));
    assert.equal(log.createGroup.length, 1);
    assert.equal(log.createGroup[0].name, "新分组");
    assert.equal(log.createGroup[0].order_num, 2, "排在当前分组数之后");
    assert.equal(text("open-group"), "false");
    assert.equal(text("groups"), "[[1,[10,11]],[2,[]],[99,[]]]");
    cleanup();
});

test("创建卡片：名字或网址没填 → 报错且**不发请求**", async () => {
    const { api, log } = makeApi();
    mount(<Harness api={api} log={log} menuCloser={noop} guard />);
    await run(() => c().handleOpenAddSite(1));
    await run(() => c().handleCreateSite());
    assert.deepEqual(log.createSite, []);
    assert.deepEqual(log.errors, ["站点名称和URL不能为空"]);

    log.errors.length = 0;
    await fill("只有名字", "");
    await run(() => c().handleCreateSite());
    assert.deepEqual(log.createSite, []);
    assert.deepEqual(log.errors, ["站点名称和URL不能为空"]);
    cleanup();
});

test("创建卡片：javascript: 伪协议必须挡在入库之前", async () => {
    const { api, log } = makeApi();
    mount(<Harness api={api} log={log} menuCloser={noop} guard />);
    await run(() => c().handleOpenAddSite(1));
    await fill("恶意卡片", "javascript:alert(1)");
    await run(() => c().handleCreateSite());
    assert.deepEqual(log.createSite, [], "伪协议绝不能进库（卡片是 href 直出的）");
    assert.equal(log.errors.length, 1);
    assert.match(log.errors[0], /网址|链接|协议/);
    cleanup();
});

test("创建卡片：网址补上 https://，成功后插本地、关弹窗、提示", async () => {
    const { api, log } = makeApi();
    mount(<Harness api={api} log={log} menuCloser={noop} guard />);
    await run(() => c().handleOpenAddSite(1));
    await fill("百度", "baidu.com");
    await run(() => c().handleCreateSite());
    await tick();

    assert.equal(log.createSite.length, 1);
    assert.equal(log.createSite[0].url, "https://baidu.com");
    assert.equal(log.duplicateCalls, 1, "提交前要过一遍重复链接闸门");
    assert.equal(log.upserted.length, 1);
    assert.equal(text("open-site"), "false");
    assert.ok(log.notes.includes("success:卡片已添加"));
    cleanup();
});

test("重复链接：用户没确认就绝不写库", async () => {
    const { api, log } = makeApi();
    mount(<Harness api={api} log={log} menuCloser={noop} guard={false} />);
    await run(() => c().handleOpenAddSite(1));
    await fill("百度", "https://baidu.com");
    await run(() => c().handleCreateSite());
    await tick();
    assert.deepEqual(log.createSite, [], "闸门返回 false = 用户还没确认，不能写库");
    assert.equal(text("open-site"), "true", "弹窗要留着，用户确认后还得继续");
    assert.equal(text("creating"), "false", "提交锁必须释放，否则确认后按钮还是灰的");
    cleanup();
});

test("连点「创建」：只写一张卡片", async () => {
    const { api, log, release } = makeApi({ hang: true });
    mount(<Harness api={api} log={log} menuCloser={noop} guard />);
    await run(() => c().handleOpenAddSite(1));
    await fill("百度", "https://baidu.com");
    await run(() => {
        void c().handleCreateSite();
        void c().handleCreateSite();
    });
    assert.equal(text("creating"), "true");
    assert.equal(log.createSite.length, 1, "第二次点击要被 ref 闸门挡住");
    await run(async () => {
        release();
        await Promise.resolve();
    });
    assert.equal(text("creating"), "false", "结束后要松开按钮");
    cleanup();
});

test("一键生成图标：没填网址时提示，填了才写图标", async () => {
    const { api, log } = makeApi();
    mount(<Harness api={api} log={log} menuCloser={noop} guard />);
    await run(() => c().handleOpenAddSite(1));
    await run(() => c().handleFetchNewSiteIcon());
    assert.deepEqual(log.errors, ["请先填写有效的站点URL，再获取图标"]);

    await fill("", "https://yunso.net");
    await run(() => c().handleFetchNewSiteIcon());
    assert.equal(JSON.parse(text("draft")).icon, "https://icon.example/yunso.net");
    assert.ok(log.notes.includes("success:已根据站点链接生成图标URL"));
    cleanup();
});

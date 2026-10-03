// tests/backupController.dom.test.tsx
// 备份控制器（useBackupController）的胶水层用例。
//
// 纯判定（什么进备份 / 什么能写回 / id 重映射）在 tests/backupScope.test.ts 里，
// 这里盯的是**只有把 hook 真跑起来才看得到**的几件事：
//
// 1. **乐观更新的回滚** —— 4 个开关都是「先拨开关再发请求」，写库失败必须拨回去。
//    漏了回滚，界面会显示一个服务端根本不存在的状态（「我以为关了自动备份」），
//    这类错觉比直接失败糟得多，因为它不会报错。
// 2. **WebDAV 口令清空要 DELETE 而不是写空串** —— worker 的 PUT 会拒空值（400），
//    而备份口令是可选的，留空才是常态。
// 3. **空备份必须当失败** —— 覆盖恢复的语义是「以这份备份为准」，
//    拿一份没有分组也没有卡片的备份去覆盖 = 把账号清空，多半是文件选错了。
// 4. **覆盖恢复要传原始数据** —— 完整性校验必须在归一化之前做，否则摘要永远对不上。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useBackupController } from "../src/hooks/useBackupController";
import { withBackupIntegrity } from "../src/utils/backupIntegrity";
import { EXPORT_VERSION } from "../src/API/http";
import type { ExportData, Group, Site, WebDavConfig } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

function mount(node: React.ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

// ---------- 假的 api ----------

interface ApiLog {
    setConfig: Array<[string, string]>;
    deleteConfig: string[];
    setConfigs: Array<Record<string, string>>;
    imports: ExportData[];
    createdGroups: string[];
    createdSites: string[];
}

function emptyApiLog(): ApiLog {
    return {
        setConfig: [],
        deleteConfig: [],
        setConfigs: [],
        imports: [],
        createdGroups: [],
        createdSites: [],
    };
}

interface ApiOptions {
    /** 这些键的写入要抛错（用来验证回滚） */
    failKeys?: string[];
    /** 这些键的写入先挂住，等用例调 release() 才继续（用来验证乐观更新） */
    holdKeys?: string[];
    /** 覆盖恢复的返回 */
    importResult?: { success: boolean; message?: string; siteIdMap?: Record<string, number> };
}

function makeApi(log: ApiLog, o: ApiOptions = {}, gates: Array<() => void> = []) {
    const fail = (key: string) => (o.failKeys ?? []).includes(key);
    const hold = (key: string) => (o.holdKeys ?? []).includes(key);
    return {
        setConfig: async (key: string, value: string) => {
            if (hold(key)) await new Promise<void>(r => gates.push(r));
            if (fail(key)) throw new Error("网络挂了");
            log.setConfig.push([key, value]);
            return { success: true };
        },
        setConfigs: async (values: Record<string, string>) => {
            log.setConfigs.push(values);
            return { success: true };
        },
        deleteConfig: async (key: string) => {
            log.deleteConfig.push(key);
            return { success: true };
        },
        importData: async (data: ExportData) => {
            log.imports.push(data);
            return o.importResult ?? { success: true, siteIdMap: { "1": 11 } };
        },
        createGroup: async (g: { name: string }) => {
            log.createdGroups.push(g.name);
            return { id: log.createdGroups.length + 100, name: g.name };
        },
        createSite: async (s: { name?: string }) => {
            log.createdSites.push(String(s.name ?? ""));
            return { id: log.createdSites.length + 200 };
        },
    };
}

// ---------- 宿主 ----------

interface HarnessState {
    apiLog: ApiLog;
    configs: Record<string, string>;
    errors: string[];
    notices: string[];
    prefSync: boolean;
    restoredPrefs: unknown[];
    webdav: WebDavConfig;
    fetchedRef: { current: number };
    gates: Array<() => void>;
}

interface Options {
    api?: ApiOptions;
    role?: "owner" | "user";
    initialConfigs?: Record<string, string>;
}

function Harness(props: {
    o: Options;
    state: { current: HarnessState };
}) {
    const { o, state } = props;
    const [configs, setConfigs] = useState<Record<string, string>>(o.initialConfigs ?? {});
    const [prefSync, setPrefSync] = useState(false);
    const [webdavConfig, setWebdavConfig] = useState<WebDavConfig>({
        url: "",
        username: "",
        password: "",
        path: "navihive-backup",
        backupPassword: "",
        allowPrivateNetwork: false,
    });
    const apiLog = useRef<ApiLog>(emptyApiLog()).current;
    const gates = useRef<Array<() => void>>([]).current;
    state.current.gates = gates;
    const errors = useRef<string[]>([]).current;
    const notices = useRef<string[]>([]).current;
    const restoredPrefs = useRef<unknown[]>([]).current;
    const fetched = useRef(0);
    const lastHealthPushRef = useRef("");
    const lastPrefPushRef = useRef("");

    const c = useBackupController({
        api: makeApi(apiLog, o.api, gates) as never,
        configs,
        groups: [
            {
                id: 1,
                name: "常用",
                order_num: 0,
                sites: [
                    { id: 1, group_id: 1, name: "A", url: "https://a.example.com", order_num: 0 },
                ],
            } as Group & { sites: Site[] },
        ] as never,
        starred: [1],
        tags: { "1": ["常用"] },
        currentUser: o.role ? { username: "u", role: o.role } : null,
        notify: (message: string) => {
            notices.push(message);
        },
        handleError: (message: string) => {
            errors.push(message);
        },
        handleMenuClose: () => {},
        fetchData: async () => {
            fetched.current += 1;
            return true;
        },
        restoreLocalPrefs: (value: unknown) => {
            restoredPrefs.push(value);
            state.current.restoredPrefs.push(value);
        },
        setConfigs: setConfigs as never,
        setWebdavConfig,
        setPrefSync,
        lastHealthPushRef,
        lastPrefPushRef,
    });

    controllerRef = c;

    // 把宿主内部的记录同步出去 —— 用例读的是 state.current
    state.current.apiLog = apiLog;
    state.current.errors = errors;
    state.current.notices = notices;
    state.current.restoredPrefs = restoredPrefs;
    state.current.fetchedRef = fetched;

    return (
        <div>
            <span data-testid='autoBackup'>{configs["webdav.autoBackup"] ?? ""}</span>
            <span data-testid='credentials'>{configs["backup.includeCredentials"] ?? ""}</span>
            <span data-testid='healthSync'>{configs["link.healthSync"] ?? ""}</span>
            <span data-testid='prefSync'>{String(prefSync)}</span>
            <span data-testid='webdavPassword'>{webdavConfig.password}</span>
            <span data-testid='errors'>{errors.join(" | ")}</span>
            <span data-testid='notices'>{notices.join(" | ")}</span>
        </div>
    );
}

// 把 hook 的返回值暴露给用例（宿主里存一份，避免在 JSX 里挂一堆按钮）
let controllerRef: ReturnType<typeof useBackupController> | null = null;

interface Mounted {
    state: { current: HarnessState };
}

async function setup(o: Options = {}): Promise<Mounted> {
    const state = {
        current: {
            apiLog: emptyApiLog(),
            configs: {},
            errors: [],
            notices: [],
            prefSync: false,
            restoredPrefs: [],
            webdav: {} as WebDavConfig,
            fetchedRef: { current: 0 },
            gates: [],
        } as HarnessState,
    };
    await act(async () => {
        mount(<Harness o={o} state={state} />);
    });
    return { state };
}

/** 放开所有被 holdKeys 挂住的写入 */
async function release(state: { current: HarnessState }) {
    await act(async () => {
        for (const g of state.current.gates.splice(0)) g();
        await Promise.resolve();
    });
}

const text = (id: string): string => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    assert.ok(el, `应有 [data-testid="${id}"]`);
    return (el!.textContent || "").trim();
};

// ==================== 乐观更新与回滚 ====================

test("自动备份开关：先拨开关再发请求（不等网络往返）", async () => {
    const { state } = await setup({
        api: { holdKeys: ["webdav.autoBackup"] },
        initialConfigs: { "webdav.autoBackup": "false" },
    });
    let pending: Promise<void> | null = null;
    act(() => {
        pending = controllerRef!.handleToggleAutoBackup(true);
    });
    assert.equal(
        text("autoBackup"),
        "true",
        "点下去就该翻转 —— 等一次网络往返才动，就是「点一下卡一下」的来源"
    );
    await release(state);
    await act(async () => {
        await pending;
    });
    assert.equal(text("autoBackup"), "true", "请求成功就停在翻转后的值");
    cleanup();
});

test("自动备份开关：写库失败要拨回原值 —— 界面不能显示服务端没有的状态", async () => {
    const { state } = await setup({
        api: { failKeys: ["webdav.autoBackup"] },
        initialConfigs: { "webdav.autoBackup": "false" },
    });
    await act(async () => {
        await controllerRef!.handleToggleAutoBackup(true).catch(() => {});
    });
    assert.equal(text("autoBackup"), "false", "失败要拨回原来的 false");
    assert.ok(
        state.current.errors.join(" | ").includes("保存自动备份设置失败"),
        "要给出错误提示"
    );
    cleanup();
});

test("备份凭据开关：失败同样回滚", async () => {
    const { state } = await setup({
        api: { failKeys: ["backup.includeCredentials"] },
        initialConfigs: { "backup.includeCredentials": "true" },
    });
    await act(async () => {
        await controllerRef!.handleToggleIncludeCredentials(false).catch(() => {});
    });
    assert.equal(text("credentials"), "true", "失败要拨回原来的 true");
    assert.ok(
        state.current.notices.join(" | ").includes("不再包含"),
        `乐观更新时提示已经弹了，回滚只回滚状态；实际：${state.current.notices.join(" | ")}`
    );
    cleanup();
});

test("星标同步开关：打开后三次写入失败要把开关拨回 false", async () => {
    await setup({ api: { failKeys: ["pref.sync"] } });
    const c = controllerRef!;
    await act(async () => {
        await c.handleTogglePrefSync(true).catch(() => {});
    });
    assert.equal(text("prefSync"), "false", "三次写入失败要回滚成关");
    cleanup();
});

test("星标同步开关：关闭时不打扰用户（关同步失败也不报错）", async () => {
    const { state } = await setup({ api: { failKeys: ["pref.sync"] } });
    const c = controllerRef!;
    await act(async () => {
        await c.handleTogglePrefSync(false);
    });
    assert.equal(text("prefSync"), "false");
    assert.deepEqual(state.current.errors, [], "关同步失败不该弹错误 —— 本机已经不再上传了");
    cleanup();
});

// ==================== WebDAV 配置保存 ====================

test("WebDAV：口令留空要走 DELETE（写空串会被 worker 以 400 拒掉）", async () => {
    const { state } = await setup();
    const c = controllerRef!;
    await act(async () => {
        await c.handleSaveWebdavConfig({
            url: "https://dav.example.com",
            username: "u",
            password: "",
            path: "navihive-backup",
            backupPassword: "",
            allowPrivateNetwork: false,
        });
    });
    assert.deepEqual(
        state.current.apiLog.deleteConfig,
        ["webdav.password", "webdav.backupPassword"],
        "两个口令都留空 → 两次 DELETE"
    );
    assert.deepEqual(state.current.apiLog.setConfig, [], "不该拿空串去 PUT");
    cleanup();
});

test("WebDAV：填了口令才写，且两个口令单独写（要加密落库）", async () => {
    const { state } = await setup();
    const c = controllerRef!;
    await act(async () => {
        await c.handleSaveWebdavConfig({
            url: "https://dav.example.com",
            username: "u",
            password: "dav-pw",
            path: "navihive-backup",
            backupPassword: "backup-pw",
            allowPrivateNetwork: false,
        });
    });
    assert.deepEqual(state.current.apiLog.setConfig, [
        ["webdav.password", "dav-pw"],
        ["webdav.backupPassword", "backup-pw"],
    ]);
    assert.deepEqual(state.current.apiLog.deleteConfig, []);
    // 非敏感的四项一次批量写完，别发 5 次往返
    assert.equal(state.current.apiLog.setConfigs.length, 1);
    assert.deepEqual(Object.keys(state.current.apiLog.setConfigs[0]).sort(), [
        "webdav.allowPrivateNetwork",
        "webdav.path",
        "webdav.url",
        "webdav.username",
    ]);
    cleanup();
});

// ==================== 导入 / 恢复 ====================

function sampleBackup(): ExportData {
    return {
        groups: [{ id: 1, name: "常用", order_num: 0 } as Group],
        sites: [
            { id: 1, group_id: 1, name: "A", url: "https://a.example.com", order_num: 0 } as Site,
        ],
        configs: {},
        version: EXPORT_VERSION,
        exportDate: new Date().toISOString(),
        localPrefs: { starred: [1], tags: { "1": ["常用"] } },
    };
}

test("空备份当成失败：覆盖恢复的语义是「以这份备份为准」", async () => {
    const { state } = await setup();
    const c = controllerRef!;
    const empty = await withBackupIntegrity({
        groups: [],
        sites: [],
        configs: {},
        version: EXPORT_VERSION,
        exportDate: new Date().toISOString(),
    } as ExportData);

    await act(async () => {
        await c.handleImportBackup(empty, true).catch(() => {});
    });
    assert.deepEqual(state.current.apiLog.imports, [], "不该真的去覆盖");
    assert.ok(
        state.current.errors.join(" | ").includes("没有任何分组或卡片"),
        `要说明为什么取消了，实际：${state.current.errors.join(" | ")}`
    );
    cleanup();
});

test("覆盖恢复：传给服务端的是原始数据（不是归一化后的）", async () => {
    const { state } = await setup();
    const c = controllerRef!;
    const backup = await withBackupIntegrity(sampleBackup());

    await act(async () => {
        await c.handleImportBackup(backup, true);
    });
    assert.equal(state.current.apiLog.imports.length, 1);
    const sent = state.current.apiLog.imports[0];
    assert.equal(sent, backup, "必须原样传 —— 归一化之后再算摘要必然对不上");
    assert.equal(state.current.fetchedRef.current, 1, "恢复完要刷新一次数据");
    cleanup();
});

test("覆盖失败（服务端说不行）要报错，且不刷新", async () => {
    const { state } = await setup({ api: { importResult: { success: false, message: "导入失败" } } });
    const c = controllerRef!;
    const backup = await withBackupIntegrity(sampleBackup());
    await act(async () => {
        await c.handleImportBackup(backup, true).catch(() => {});
    });
    assert.ok(
        state.current.errors.join(" | ").includes("导入失败"),
        `实际：${state.current.errors.join(" | ")}`
    );
    assert.equal(state.current.fetchedRef.current, 0, "没导入成功不该刷新");
    cleanup();
});

test("合并导入：分组与站点一条条建，且站点挂到新建的分组上", async () => {
    const { state } = await setup();
    const backup = await withBackupIntegrity(sampleBackup());
    await act(async () => {
        await controllerRef!.handleImportBackup(backup, false);
    });
    assert.deepEqual(state.current.apiLog.createdGroups, ["常用"]);
    assert.deepEqual(state.current.apiLog.createdSites, ["A"]);
    assert.deepEqual(state.current.apiLog.imports, [], "合并模式不走整体导入");
    cleanup();
});

test("损坏的备份：校验不过就不动现有数据", async () => {
    const { state } = await setup();
    const c = controllerRef!;
    const backup = await withBackupIntegrity(sampleBackup());
    const broken = { ...backup, integrity: { algo: "SHA-256", value: "0".repeat(64) } };

    await act(async () => {
        await c.handleImportBackup(broken, true).catch(() => {});
    });
    assert.deepEqual(state.current.apiLog.imports, [], "摘要对不上就不该导入");
    assert.ok(
        state.current.errors.join(" | ").includes("校验失败"),
        `实际：${state.current.errors.join(" | ")}`
    );
    cleanup();
});

// tests/useNotesSwr.dom.test.tsx
// 记事本列表的模块级 SWR 缓存（2026-10-17）：NotesOverlay 关掉即卸载，
// 缓存让「第二次打开」先把上次的列表渲染出来（0 等待），挂载后的 reload
// 照常在后台校准。这里钉住四件事：
//   1. 二次挂载的第一帧就能看到缓存列表（不等网络），且校准请求照发；
//   2. 校准新数据落地后替换缓存值；
//   3. 校准失败（断网）时列表保留、不弹「加载失败」（有数据可见时吓人没意义）；
//   4. 无缓存的首次打开失败仍弹错误（旧行为不丢），空态绝不写缓存。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNotes, clearNotesSwrCache, type NotesApiLike } from "../src/hooks/useNotes";
import { setActiveAccount, clearActiveAccount } from "../src/utils/accountScope";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Note } from "../src/API/types";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
    if (root) {
        act(() => root!.unmount());
        root = null;
    }
    if (host) {
        host.remove();
        host = null;
    }
    document.body.innerHTML = "";
    // 跨用例隔离：模块级缓存必须清掉，否则上一条用例的数据会渗进下一条
    clearNotesSwrCache();
    clearActiveAccount();
});

function makeNote(id: number, title: string, rev = 1): Note {
    return {
        id,
        uuid: `u${id}`,
        title,
        content: `内容${id}`,
        pinned: false,
        rev,
        order_num: 0,
        site_id: null,
    } as Note;
}

interface MountResult {
    hook: () => ReturnType<typeof useNotes>;
    listCalls: number;
    errors: string[];
    unmount: () => Promise<void>;
}

/**
 * 挂一个只关心「列表行为」的 useNotes 替身环境。
 * listNotes 由调用方给（可挂起 / 可抛错）；回调定义在 Probe 外面 ——
 * 身份一变 reload 就重跑（见 noteWriteQueue.dom.test.tsx 的 OOM 教训）。
 */
async function mountSwr(listNotes: () => Promise<Note[]>): Promise<MountResult> {
    let listCalls = 0;
    const errors: string[] = [];
    const seen: ReturnType<typeof useNotes>[] = [];
    const onError = (message: string) => errors.push(message);
    const onNotify = () => {};
    // ⚠️ api 必须定义在 Probe 外面：写在 JSX 里每次渲染都是新对象，
    // reload 依赖 api → 身份一变就重跑 reload → setNotes → 再渲染 → 无限循环 OOM
    // （同 noteWriteQueue.dom.test.tsx 的教训）。
    const api = {
        listNotes: () => {
            listCalls += 1;
            return listNotes();
        },
    } as unknown as NotesApiLike;
    function Probe() {
        const value = useNotes({
            api,
            onError,
            onNotify,
        });
        seen.push(value);
        return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <Probe />
            </UIPrefsProvider>
        );
    });
    const unmount = async () => {
        await act(async () => {
            root!.unmount();
            root = null;
        });
    };
    return { hook: () => seen.at(-1)!, listCalls, errors, unmount };
}

test("二次打开：第一帧就渲染缓存列表，校准请求照发，新数据落地后替换", async () => {
    setActiveAccount(7);
    // 第一次打开：正常拿到两条，落地后写进缓存
    const first = await mountSwr(async () => [makeNote(1, "A"), makeNote(2, "B")]);
    await act(async () => {
        await Promise.resolve();
    });
    assert.equal(first.hook().notes.length, 2);
    assert.equal(first.hook().loaded, true);
    await first.unmount();

    // 第二次打开：列表请求挂住（模拟慢链路 RTT），第一帧就该有缓存
    let release: () => void = () => {};
    const gate = new Promise<Note[]>(resolve => {
        release = () => resolve([makeNote(1, "A"), makeNote(2, "B"), makeNote(3, "C")]);
    });
    const second = await mountSwr(() => gate);
    assert.equal(second.listCalls, 1, "缓存只管渲染，校准请求必须照发");
    assert.equal(second.hook().notes.length, 2, "第一帧直接用缓存渲染，不等网络");
    assert.equal(second.hook().loaded, true, "有缓存时 loaded 直接为 true");
    await act(async () => {
        release();
        await gate;
    });
    assert.equal(second.hook().notes.length, 3, "校准数据落地后替换缓存值");
    await second.unmount();
});

test("二次打开后校准失败：缓存列表保留，不弹「加载失败」", async () => {
    setActiveAccount(7);
    const first = await mountSwr(async () => [makeNote(1, "A")]);
    await act(async () => {
        await Promise.resolve();
    });
    await first.unmount();

    const second = await mountSwr(async () => {
        throw new Error("网络断开");
    });
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.equal(second.hook().notes.length, 1, "缓存列表保留，不能被失败清空");
    assert.deepEqual(second.errors, [], "列表可见时不再弹「加载失败」吓人");
    await second.unmount();
});

test("无缓存的首次打开失败：仍弹错误（旧行为），空态绝不写缓存", async () => {
    setActiveAccount(7);
    const first = await mountSwr(async () => {
        throw new Error("网络断开");
    });
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.deepEqual(first.errors, ["加载记事本失败: 网络断开"], "无缓存时保持旧的错误提示");
    assert.equal(first.hook().loaded, false, "没拿到过服务端数据，loaded 必须仍是 false");

    // 紧接着再开一次：缓存里必须还是空的（空态没有资格当缓存）
    const second = await mountSwr(() => new Promise<Note[]>(() => {}));
    assert.equal(second.hook().notes.length, 0, "空态不能渗进下一次打开");
    assert.equal(second.hook().loaded, false);
    await second.unmount();
});

test("按账号分桶：A 账号的缓存不会渗给 B 账号", async () => {
    setActiveAccount(1);
    const first = await mountSwr(async () => [makeNote(11, "甲的笔记")]);
    await act(async () => {
        await Promise.resolve();
    });
    await first.unmount();

    setActiveAccount(2);
    let release: () => void = () => {};
    const gate = new Promise<Note[]>(resolve => {
        release = () => resolve([makeNote(22, "乙的笔记")]);
    });
    const second = await mountSwr(() => gate);
    assert.equal(second.hook().notes.length, 0, "换账号后不能看到上一个账号的缓存");
    await act(async () => {
        release();
        await gate;
    });
    assert.equal(second.hook().notes.length, 1);
    await second.unmount();
});

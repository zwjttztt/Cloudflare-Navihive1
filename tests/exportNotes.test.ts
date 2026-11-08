// tests/exportNotes.test.ts
//
// 需求 4 的**前端导出侧**：手动导出的 JSON / ZIP 必须把站点指纹写进 payload。
// 服务端 importNotesData 靠「有没有 boundSites 这个键」区分新格式与老格式 ——
// 老导出文件完全没写时才会把 notes[].site_id 全部置 null，于是「删掉绑了网站的笔记
// → 重新导入」绑定就丢了。这里钉死三件事：
//   1. 两条导出路径都要写出这个键（哪怕一条都没绑，也要是空数组，不能省键）；
//   2. payload 里的 boundSites 就是本次导出笔记引用到的那几条，不搬全量站点表；
//   3. notes[].site_id 原样带出，别在前端先抹掉。
//
// ⚠️ 「只挑被引用站点」的筛选在 useNotesPageModel.tsx 的 exportAllData / exportAllZip
// 里（只有它同时拿得到 full 与 siteLinkApi）；这里测的是 exportNotes.ts 的契约：
// 调用方给什么就原样写什么、且必须写出这个键。

import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { exportAllNotesJson, exportAllNotesZip } from "../src/components/notes/exportNotes";
import { readZip } from "../src/utils/zip";
import type { Note } from "../src/API/types";

interface SiteFingerprint {
    id: number;
    name: string;
    url: string;
}

interface ExportedPayload {
    notes?: Array<{ id?: number; site_id?: number | null }>;
    boundSites?: SiteFingerprint[];
}

let cleanup: (() => void) | null = null;

afterEach(() => {
    cleanup?.();
    cleanup = null;
});

/**
 * 纯函数用例没有 jsdom（script/unit-tests.mjs 的 BANNER_PURE 只补 localStorage），
 * 所以 document / URL.createObjectURL 都得自己给最小替身，风格照 tests/recoveryKey.test.ts。
 */
function captureDownloads(): Blob[] {
    const blobs: Blob[] = [];
    const originals = {
        create: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
        revoke: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
        document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    };

    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: (blob: Blob) => { blobs.push(blob); return "blob:stub"; },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: () => undefined,
    });
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: {
            createElement: () => ({
                href: "",
                download: "",
                click() {},
                remove() {},
            }),
            body: { appendChild() {} },
        },
    });

    const restore = (obj: object, key: string, desc: PropertyDescriptor | undefined) => {
        if (desc) Object.defineProperty(obj, key, desc);
        else Reflect.deleteProperty(obj, key);
    };
    cleanup = () => {
        restore(URL, "createObjectURL", originals.create);
        restore(URL, "revokeObjectURL", originals.revoke);
        restore(globalThis, "document", originals.document);
    };
    return blobs;
}

/** JSON 直接读文本；ZIP 先从 notes.json 条目里解出来再读 */
async function readPayload(blob: Blob, fromZip: boolean): Promise<ExportedPayload> {
    if (!fromZip) return JSON.parse(await blob.text()) as ExportedPayload;
    const entries = await readZip(new Uint8Array(await blob.arrayBuffer()));
    const notesJson = entries.find(e => e.path === "notes.json");
    assert.ok(notesJson, "ZIP 里必须有 notes.json");
    return JSON.parse(new TextDecoder().decode(notesJson.data)) as ExportedPayload;
}

const notes: Note[] = [
    { id: 1, title: "甲", content: "正文甲", site_id: 7 },
    { id: 2, title: "乙", content: "正文乙", site_id: 9 },
    { id: 3, title: "丙", content: "正文丙", site_id: null },
];

// 假装这是 siteLinkApi.list() 给的全量站点表：只有 7 / 9 被上面的笔记引用，8 没有。
const siteTable: SiteFingerprint[] = [
    { id: 7, name: "站点甲", url: "https://a.example" },
    { id: 8, name: "没被引用的站点", url: "https://b.example" },
    { id: 9, name: "站点丙", url: "https://c.example" },
];
// 与 useNotesPageModel.tsx 的 exportAllData / exportAllZip 同口径：按 full 现算引用集合
const ids = new Set(notes.map(n => n.site_id).filter((id): id is number => typeof id === "number"));
const boundSites = siteTable
    .filter(s => ids.has(s.id))
    .map(s => ({ id: s.id, name: s.name || "", url: s.url || "" }));
const expectedSites: SiteFingerprint[] = [
    { id: 7, name: "站点甲", url: "https://a.example" },
    { id: 9, name: "站点丙", url: "https://c.example" },
];

function assertBoundSites(payload: ExportedPayload) {
    assert.ok(
        Object.prototype.hasOwnProperty.call(payload, "boundSites"),
        "payload 必须写出 boundSites 键（服务端靠它区分新 / 老格式）"
    );
    assert.deepEqual(payload.boundSites, expectedSites, "只带被引用的站点，别搬全量站点表");
    assert.equal(payload.boundSites!.length, 2);
    assert.ok(!payload.boundSites!.some(s => s.id === 8), "没被引用的站点不能混进 payload");
    assert.deepEqual(
        payload.notes?.map(n => n.site_id),
        [7, 9, null],
        "notes[].site_id 要原样带出，别在前端先抹掉"
    );
}

test("JSON 导出：payload 带 boundSites，且只含被引用站点", async () => {
    const blobs = captureDownloads();
    // 源码下载后 4000ms 才 revokeObjectURL：用假定时器走完，别留一条真定时器拖住进程
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        exportAllNotesJson({ notes, boundSites });
        mock.timers.tick(4001);
    } finally {
        mock.timers.reset();
    }
    assert.equal(blobs.length, 1, "JSON 导出只造一个 Blob");
    assertBoundSites(await readPayload(blobs[0]!, false));
});

test("ZIP 导出：notes.json 里带 boundSites，且只含被引用站点", async () => {
    const blobs = captureDownloads();
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        await exportAllNotesZip({ notes, boundSites });
        mock.timers.tick(4001);
    } finally {
        mock.timers.reset();
    }
    assert.equal(blobs.length, 1, "ZIP 导出只造一个 Blob");
    assertBoundSites(await readPayload(blobs[0]!, true));
});

test("不传 boundSites 时仍写出空数组键（老格式靠「没有这个键」识别）", async () => {
    const blobs = captureDownloads();
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        exportAllNotesJson({ notes });
        await exportAllNotesZip({ notes });
        mock.timers.tick(4001);
    } finally {
        mock.timers.reset();
    }
    assert.equal(blobs.length, 2, "两条路径各造一个 Blob");
    for (const [i, blob] of blobs.entries()) {
        const payload = await readPayload(blob, i === 1);
        assert.ok(
            Object.prototype.hasOwnProperty.call(payload, "boundSites"),
            "没绑站点也要写出这个键，不能省"
        );
        assert.deepEqual(payload.boundSites, [], "空数组而不是缺键 / null");
    }
});

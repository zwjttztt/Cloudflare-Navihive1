// tests/panelScrollChain.test.ts
// 「面板里的内容滚得到吗」的**静态守卫**（2026-10-31）。
//
// ── 为什么要这条守卫 ─────────────────────────────────────────────────────
// 2026-10-31 我在 ui-probe 里量到「从 WebDAV 恢复」那个框比可视下沿低 67.9px、
// 而且所在地滚动容器 scrollHeight 恒等于 clientHeight —— 据此报了「内容被裁掉且
// 滚不到」的缺陷。同一天复查时就发现**那个结论是错的**：
//   · `[data-workspace-panel-body]` 是 SettingsWorkspacePanel 的**直通容器**
//     （display:block，唯一子元素 height:100%），它按设计永远不滚；
//   · 真正会滚的是面板内部那一层（备份面板 = BackupDialog 里 ref=scrollRef 的 Box）。
//     在 1440×950 下它有 157px 可滚量，滚到底那个框完整可见（探针实测 ✅）。
// 也就是说：**「scrollHeight === clientHeight」本身不是 bug**，要先确认自己量的是
// 不是那个真的会滚的容器。这个教训值得钉住 —— 但钉的不是那句量错的行，而是
// 「哪些声明一旦没了，内容就真的看不到了」。
//
// ── 判据怎么来的（全部实测，不是推理） ───────────────────────────────────
// 每条规则都做过「改掉 → 重建 → 用探针量」的实验：
//
//   规则 1  SettingsWorkspacePanel 的正文 Box 必须 overflowY: "auto"
//           改 visible 后：全站设置最后一行（拼音搜索的说明）在 950/820/720/640/560
//           五档高度上**全部不可达**（没有可滚祖先，跑出纸面即永久看不见）。
//           它是 9 屏里 8 屏唯一的滚动出口（只有备份面板自己另有一层）。
//
//   规则 2  RestoreTab 根 Stack 必须 flex: "1 0 auto"（不许被压缩）
//           改回 flex: 1 后：备份面板「从 WebDAV 恢复」框在五档高度上**全部滚不到**
//           （框底越过滚动容器下沿 0.9px，可滚量从 157 掉到 121）。
//           这就是 2026-10-26 那个「框和底部按钮区重叠」缺陷的复现路径 —— 原注释
//           里写着它当时被压成 187 / 88 / 8 / 0px。
//
//   规则 3  BackupDialog 内层滚动容器必须 overflowY: "auto"
//           ⚠️ 这一条**不是可达性**：改 visible 后内容仍然可达（由规则 1 那层接管）。
//           它守的是「备份 / 恢复两个标签页与底部那句署名不跟着滚」——
//           滚动容器在它们中间，一旦这层退出滚动，整块（含标签页）都会滚走。
//
//   规则 4  RestoreTab 里远端备份列表必须自己 overflowY: "auto"
//           ⚠️ 这一条**未实测**（要起一个真的 WebDAV 服务才有第二条记录）。判据是
//           结构的：它父盒是「minHeight: 220 + overflow: hidden」的固定窗口，
//           列表不自滚，第 N 条以后的远端备份就永远看不见。标注清楚，别当成实测结论。
//
// ── 刻意**没有**钉的东西（免得下一个人「顺手补上」） ────────────────────
// 那几个滚动容器上的 `minHeight: 0` **没有**钉。实测结论：把 BackupDialog 内层
// 滚动容器的 `minHeight: 0` 删掉，重建后五档高度的数字**逐字相同**、全部 ✅。
// 原因是 CSS 规定「flex 子项若 overflow 非 visible，automatic minimum size 就是 0」，
// 这行是冗余的。给冗余行加断言只会制造假红 —— 那种守卫比没有更糟。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

const ROOT = findProjectDir();

const PANEL_FILE = "src/components/settingsWorkspace/SettingsWorkspacePanel.tsx";
const BACKUP_FILE = "src/components/BackupDialog.tsx";
const RESTORE_FILE = "src/components/RestoreTab.tsx";

export interface ScrollRule {
    /** 规则名，出现在失败信息里 */
    id: string;
    /** 相对项目根的路径 */
    file: string;
    /** 用来定位的那段源码（必须唯一，否则规则自己就失效了） */
    anchor: string;
    /** 锚点往**前**找多少字符（sx 写在 JSX 属性之前） */
    before?: number;
    /** 锚点往**后**找多少字符（sx 写在 JSX 属性之后） */
    after?: number;
    /** 必须出现的片段 */
    must: string;
    /** 为什么必须（失败信息里原样打出来，省得人再去翻 git log） */
    why: string;
}

export const SCROLL_RULES: ScrollRule[] = [
    {
        id: "panel-body-scrolls",
        file: PANEL_FILE,
        // 动画声明在正文 Box 的 sx 末尾，唯一
        anchor: 'animation: "navPanelFade var(--dur-base) var(--ease-out)"',
        before: 600,
        must: 'overflowY: "auto"',
        why:
            "面板正文是 9 屏里 8 屏唯一的滚动出口（只有备份面板另有一层）。" +
            "实测改成 visible 后，全站设置最后一行在五档高度上全部不可达 —— 跑出纸面即永久看不见。",
    },
    {
        id: "restore-root-not-shrinkable",
        file: RESTORE_FILE,
        anchor: "<Stack spacing={1.5} sx={{ mt: 0.5,",
        after: 200,
        must: 'flex: "1 0 auto"',
        why:
            "备份/恢复这块一旦允许被压缩（flex: 1 = 1 1 0%），矮视口下它会被压到比内容矮，" +
            "「从 WebDAV 恢复」框溢出父级被切一刀 —— 2026-10-26 那个「框和底部按钮区重叠」的缺陷。" +
            "实测改回 flex: 1 后五档高度上那个框全部滚不到。",
    },
    {
        id: "backup-inner-scroller",
        file: BACKUP_FILE,
        anchor: "ref={scrollRef}",
        // sx 写在 ref 之后（JSX 属性顺序），所以往**后**找
        after: 400,
        must: 'overflowY: "auto"',
        why:
            "这层不是可达性判据（它退出滚动后由面板正文接管，内容仍看得到），" +
            "但它把「备份 / 恢复」两个标签页与底部那句署名钉在滚动区外；" +
            "一旦它不滚，标签页会跟着正文一起滚走。",
    },
    {
        id: "remote-file-list-scrolls",
        file: RESTORE_FILE,
        anchor: "remoteFiles.map(file => (",
        before: 600,
        must: 'overflowY: "auto"',
        why:
            "远端备份列表的父盒是 minHeight: 220 + overflow: hidden 的固定窗口；" +
            "列表自己不自滚，第 N 条以后的远端备份永远看不见（此条为结构判据，未起 WebDAV 服务实测）。",
    },
];

/** 把源码里某个偏移换算成 1 起的行号 */
function lineAt(src: string, index: number): number {
    return src.slice(0, index).split("\n").length;
}

/**
 * 跑一遍规则，返回失败清单（空 = 全过）。
 *
 * 纯函数：传进来的 `files` 是「相对路径 → 源码」，所以测试里可以在内存里改坏一份
 * 再喂进来做反向验证，不必真的去改工作区的文件。
 */
export function checkScrollChain(files: Record<string, string>): string[] {
    const failures: string[] = [];
    for (const rule of SCROLL_RULES) {
        const raw = files[rule.file];
        if (raw === undefined) {
            failures.push(`${rule.file}：读不到这个文件`);
            continue;
        }
        // 归一化行尾：仓库里 CRLF / LF 都出现过，行号要稳
        const src = raw.replace(/\r\n/g, "\n");
        const at = src.indexOf(rule.anchor);
        if (at < 0) {
            failures.push(
                `${rule.file}：找不到锚点「${rule.anchor}」—— 结构被改过了，` +
                    `守卫失效比守卫报错更糟，先看这条规则还需要不要（规则 ${rule.id}）`
            );
            continue;
        }
        if (src.indexOf(rule.anchor, at + 1) >= 0) {
            failures.push(
                `${rule.file}：锚点「${rule.anchor}」不唯一 —— 规则 ${rule.id} 会盯错地方，换一个锚点`
            );
            continue;
        }
        const from = Math.max(0, at - (rule.before ?? 0));
        const to = Math.min(src.length, at + (rule.after ?? 0));
        const window = src.slice(from, to);
        if (!window.includes(rule.must)) {
            failures.push(
                `${rule.file}:${lineAt(src, at)} → ${rule.id}：` +
                    `锚点「${rule.anchor}」附近（±${rule.before ?? 0}/${rule.after ?? 0} 字符）` +
                    `找不到 \`${rule.must}\`。${rule.why}`
            );
        }
    }
    return failures;
}

/** 读工作区里的真文件 */
function liveSources(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rel of [PANEL_FILE, BACKUP_FILE, RESTORE_FILE]) {
        out[rel] = readFileSync(join(ROOT, rel), "utf8");
    }
    return out;
}

test("四条滚动链条规则在真树上全过", () => {
    const failures = checkScrollChain(liveSources());
    assert.deepEqual(failures, [], "面板的滚动链条断了：" + failures.join("\n"));
});

// ---- 反向验证：每条规则都必须真的能红 -----------------------------------
// 不是「改一次看见红就算了」—— 把变异写在测试里，别人删了规则或写错锚点，
// 这几条会立刻变绿失败（因为它们断言「必须有失败」）。

function mutated(file: string, from: string, to: string): Record<string, string> {
    const files = liveSources();
    const src = files[file]!.replace(/\r\n/g, "\n");
    assert.ok(src.includes(from), `变异点不存在：${file} 里的 ${from.slice(0, 40)}`);
    files[file] = src.replace(from, to);
    return files;
}

test("反向验证 1：面板正文改成 overflowY visible → 必须红（实测改坏后五档高度全不可达）", () => {
    const files = mutated(PANEL_FILE, 'overflowY: "auto"', 'overflowY: "visible"');
    const failures = checkScrollChain(files);
    assert.equal(failures.length, 1, "只该报这一条：" + failures.join(" | "));
    assert.match(failures[0]!, /panel-body-scrolls/);
    assert.match(failures[0]!, /SettingsWorkspacePanel\.tsx:\d+/);
});

test('反向验证 2：RestoreTab 根改回 flex: 1 → 必须红（实测改坏后 WebDAV 框滚不到）', () => {
    const files = mutated(RESTORE_FILE, 'flex: "1 0 auto"', "flex: 1");
    const failures = checkScrollChain(files);
    assert.equal(failures.length, 1, "只该报这一条：" + failures.join(" | "));
    assert.match(failures[0]!, /restore-root-not-shrinkable/);
    // 只校验「点了文件名 + 行号」，不钉具体行号 —— 上面加两行注释就会变成假红
    assert.match(failures[0]!, /RestoreTab\.tsx:\d+/);
});

test("反向验证 3：备份内层滚动容器改成 visible → 必须红（标签页会跟着滚走）", () => {
    const files = mutated(BACKUP_FILE, 'overflowY: "auto"', 'overflowY: "visible"');
    const failures = checkScrollChain(files);
    assert.equal(failures.length, 1, "只该报这一条：" + failures.join(" | "));
    assert.match(failures[0]!, /backup-inner-scroller/);
});

test("反向验证 4：远端列表不自滚 → 必须红（第 N 条之后的备份看不见）", () => {
    const files = mutated(RESTORE_FILE, 'overflowY: "auto"', 'overflowY: "hidden"');
    const failures = checkScrollChain(files);
    // 这条变异会同时踩到「远端列表」与……只该是列表那一条：RestoreTab 里
    // overflowY: "auto" 只出现在列表上（根 Stack 用的是 flex）
    assert.equal(failures.length, 1, "只该报这一条：" + failures.join(" | "));
    assert.match(failures[0]!, /remote-file-list-scrolls/);
});

test("反向验证 5：锚点被删（结构大改）→ 必须红，且提示去看规则还需要不要", () => {
    const files = mutated(RESTORE_FILE, "remoteFiles.map(file => (", "remoteFiles.map(f => (");
    const failures = checkScrollChain(files);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!, /找不到锚点/);
});

test("反向验证 6：锚点重复（改成两处）→ 必须红，别盯错地方", () => {
    const files = liveSources();
    const src = files[BACKUP_FILE]!.replace(/\r\n/g, "\n");
    files[BACKUP_FILE] = src.replace("ref={scrollRef}", "ref={scrollRef}\n                ref={scrollRef}");
    const failures = checkScrollChain(files);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!, /不唯一/);
});

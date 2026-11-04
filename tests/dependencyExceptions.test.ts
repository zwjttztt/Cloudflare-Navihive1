// tests/dependencyExceptions.test.ts
//
// 「依赖公告例外登记」的守卫（审查项 R18）。
//
// 背景：dev 链上有两条真公告（glob / minimatch），在「只允许 patch/minor」的约束下
// 消不掉，于是走了**有期限例外**——登记在 docs/dependency-upgrade-assessment.md 的表里。
//
// 例外这机制烂掉的方式只有一种：**没人回头看**。「到期日」写在文档里、没有东西读它，
// 就等于写了一行好看的字：三个月后没人记得，一年后表里留着 5 条早已修好的包，
// 而真正新出现的那条又没人加进去。
//
// 所以这个用例把那张表当**配置**读，钉四件事：
//   1. 每条例外都有责任人（不能是「大家」）；
//   2. 每条都有**可解析、未过期、且不超过 12 个月**的到期日（不许拿 2099 年糊过去）；
//   3. 公告 ID 形状正确（GHSA-xxxx-xxxx-xxxx），且和第 1 节列的公告对得上
//      —— 文档里新冒出一条公告却没进例外表，这里就红；
//   4. 生产依赖基线声明必须写着 0、并且带一个不超过 180 天的核对日期。
//
// ⚠️ 第 4 条**故意不联网**：跑 `npm audit` 的用例会在没网 / registry 抽风时随机变红，
// 而守卫必须稳。这里只检查「文档里的声明是否还新鲜」，真正的 audit 由 CI 那两步做。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============  helpers ============

/** 单测会被打包到 script/tmp-tests/ 下再跑，逐级向上找真身（ESM 没有 __dirname） */
function projectDir(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录（6 层内没有 package.json）");
}

const ROOT = projectDir();
const DOC_REL = "docs/dependency-upgrade-assessment.md";
const DOC = readFileSync(path.join(ROOT, DOC_REL), "utf8");

const DAY_MS = 86_400_000;
/** 到期日最远只能挂 12 个月多一点：再长就等于「无限期」 */
const MAX_HORIZON_DAYS = 400;
/** 生产基线声明的保鲜期：半年必须重跑一次 audit 并更新日期 */
const BASELINE_MAX_AGE_DAYS = 180;
/** 公告 ID 的标准形状（GitHub Advisory 一律 3 组 4 位） */
const GHSA_RE = /GHSA(-[0-9a-z]{4}){3}/g;

interface Table {
    header: string[];
    rows: string[][];
}

const cellsOf = (line: string): string[] =>
    line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());

/** 取某个**小节**（`##` 及以下、标题含 headingFragment）下面的第一张 Markdown 表 */
function tableUnderHeading(headingFragment: string): Table {
    const lines = DOC.split(/\r?\n/);
    // ⚠️ 只认 `##` 及以下：本文档的 H1（`# 附录：…`）也含「依赖公告例外登记」这几个字，
    // 按「含 # 就匹配」会先撞上 H1，然后在正文里找不到表 —— 这个坑踩过了。
    const start = lines.findIndex(
        (line) => /^#{2,6}\s/.test(line) && line.includes(headingFragment),
    );
    assert.ok(start >= 0, `文档里找不到标题含「${headingFragment}」的小节`);

    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        // 到下一节还没遇到表：这个小节里根本没表
        if (line.startsWith("#")) break;
        if (!line.trimStart().startsWith("|")) continue;

        const sep = lines[i + 1] ?? "";
        assert.match(
            sep,
            /^\s*\|[\s:|-]+\|\s*$/,
            `「${headingFragment}」那张表少了 Markdown 分隔行（|---|），表格会渲染坏`,
        );

        const rows: string[][] = [];
        for (let j = i + 2; j < lines.length; j++) {
            const row = lines[j] ?? "";
            if (!row.trimStart().startsWith("|")) break;
            rows.push(cellsOf(row));
        }
        return { header: cellsOf(line), rows };
    }

    assert.fail(`「${headingFragment}」小节下面没有表格`);
}

/** 取**表头单元格里**含 fragment 的第一张表（用于正文中以表代节的那几张） */
function tableWithHeaderCell(fragment: string): Table {
    const lines = DOC.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!line.trimStart().startsWith("|")) continue;
        const header = cellsOf(line);
        if (!header.some((cell) => cell.includes(fragment))) continue;

        const sep = lines[i + 1] ?? "";
        assert.match(sep, /^\s*\|[\s:|-]+\|\s*$/, `表头含「${fragment}」的那张表少了分隔行`);

        const rows: string[][] = [];
        for (let j = i + 2; j < lines.length; j++) {
            const row = lines[j] ?? "";
            if (!row.trimStart().startsWith("|")) break;
            rows.push(cellsOf(row));
        }
        return { header, rows };
    }
    assert.fail(`文档里找不到表头含「${fragment}」的表格`);
}

/** 去掉 Markdown 的行内代码标记（`glob` → glob），其余原样保留 */
const plain = (cell: string): string => cell.replace(/`/g, "").trim();

/** 表头名 → 列下标。列顺序变了也能读，但列**名字**不许改。 */
function column(table: Table, name: string): number {
    const index = table.header.indexOf(name);
    assert.ok(index >= 0, `表头缺「${name}」列（现有：${table.header.join(" / ")}）`);
    return index;
}

/** YYYY-MM-DD → epoch ms。不合法（2027-02-30 这种）直接判红，不做宽容修正。 */
function parseDay(raw: string, where: string): number {
    const text = plain(raw);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    assert.ok(m, `${where}：日期必须写成 YYYY-MM-DD，实际是「${raw}」`);
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ms = Date.UTC(y, mo - 1, d);
    assert.equal(
        new Date(ms).toISOString().slice(0, 10),
        text,
        `${where}：日期不存在（${text}）`,
    );
    return ms;
}

interface Exception {
    pkg: string;
    version: string;
    advisories: string[];
    owner: string;
    untilRaw: string;
    recheck: string;
    where: string;
}

/** 把「依赖公告例外登记」那张表读成结构化数据 */
function dependencyExceptions(): Exception[] {
    const table = tableUnderHeading("依赖公告例外登记");
    const c = {
        pkg: column(table, "包名"),
        version: column(table, "当前版本"),
        advisory: column(table, "公告 ID"),
        owner: column(table, "责任人"),
        until: column(table, "到期日"),
        recheck: column(table, "复查命令"),
    };
    return table.rows.map((row, index) => {
        const at = `第 ${index + 1} 条例外（${plain(row[c.pkg] ?? "")}）`;
        return {
            pkg: plain(row[c.pkg] ?? ""),
            version: plain(row[c.version] ?? ""),
            advisories: plain(row[c.advisory] ?? "").match(GHSA_RE) ?? [],
            owner: plain(row[c.owner] ?? ""),
            untilRaw: plain(row[c.until] ?? ""),
            recheck: plain(row[c.recheck] ?? ""),
            where: at,
        };
    });
}

// ============ 例外表本体 ============

test("例外登记表存在、列名齐全、且至少有一条在册", () => {
    const rows = dependencyExceptions();
    assert.ok(rows.length > 0, "例外表是空的 —— 那它就没在记录任何东西");
    for (const row of rows) {
        assert.match(row.pkg, /^[A-Za-z0-9@][\w@/.-]*$/, `${row.where}：包名不像包名`);
        // 版本必须能看到具体数字：写「latest」「未知」等于没写
        assert.match(
            row.version,
            /^\d+\.\d+\.\d+/,
            `${row.where}：当前版本要写具体版本号（现在写的是「${row.version}」）`,
        );
        assert.ok(row.recheck.length > 0, `${row.where}：复查命令不能空`);
    }
});

test("每条例外都有责任人，且不是「大家」这种糊弄过去的写法", () => {
    for (const row of dependencyExceptions()) {
        assert.ok(
            row.owner.length >= 2,
            `${row.where}：没写责任人。例外必须挂在一个具体的人身上，否则到期了没人管`,
        );
        assert.doesNotMatch(
            row.owner,
            /^(待定|TBD|todo|大家|所有人|unknown)$/i,
            `${row.where}：责任人写的是「${row.owner}」—— 等于没有责任人`,
        );
    }
});

test("每条例外的到期日可解析、未过期，且不超过 12 个月", () => {
    const now = Date.now();
    for (const row of dependencyExceptions()) {
        const until = parseDay(row.untilRaw, row.where);
        assert.ok(
            until > now,
            `${row.where}：到期日 ${row.untilRaw} 已过期 — 要么修掉，要么写明理由续期（并更新到期日）`,
        );
        assert.ok(
            until <= now + MAX_HORIZON_DAYS * DAY_MS,
            `${row.where}：到期日 ${row.untilRaw} 超过 12 个月 — 例外不能无限期挂账`,
        );
    }
});

test("公告 ID 是标准 GHSA 形状且不重复", () => {
    const seen = new Map<string, string>();
    for (const row of dependencyExceptions()) {
        assert.ok(
            row.advisories.length > 0,
            `${row.where}：公告 ID 栏里没有形如 GHSA-xxxx-xxxx-xxxx 的 ID`,
        );
        for (const id of row.advisories) {
            const prev = seen.get(id);
            assert.equal(
                prev,
                undefined,
                `${row.where}：公告 ${id} 已经在「${prev}」登记过了 —— 一条公告只该有一行，` +
                    "重复登记会让「到期日」出现两个互相矛盾的答案",
            );
            seen.set(id, row.where);
        }
    }
});

test("文档里点名的公告都进了例外表（新公告不许只写在正文里）", () => {
    // 第 1 节那张「真正带公告的包」表是**事实清单**：哪天多了一条公告，先改那里，
    // 再决定它是被修掉了还是得进例外表。两边对不上，说明中间少走了一步。
    const inventory = tableWithHeaderCell("真正带公告的包");
    const mentioned = new Set<string>();
    for (const row of inventory.rows) {
        for (const cell of row) {
            for (const id of plain(cell).match(GHSA_RE) ?? []) mentioned.add(id);
        }
    }
    assert.ok(mentioned.size > 0, "第 1 节那张表里一个 GHSA 编号都没有，表大概被改坏了");

    const registered = new Set(dependencyExceptions().flatMap((row) => row.advisories));
    for (const id of mentioned) {
        assert.ok(
            registered.has(id),
            `公告 ${id} 出现在第 1 节，但例外表里没有它 —— ` +
                "要么已升到修复版（那就把它从第 1 节删掉），要么登进例外表（带责任人与到期日）",
        );
    }
});

// ============ 生产依赖基线声明 ============

test("生产依赖基线声明写着 0，且核对日期不超过 180 天", () => {
    // ⚠️ 必须排除标题行：小节标题「## 3. 生产依赖基线」也含这几个字，先撞上它就会
    // 报「格式不对」，而真正的原因只是找错了行。
    const line = DOC.split(/\r?\n/).find(
        (l) => !l.trimStart().startsWith("#") && /生产依赖基线：\s*\d/.test(l),
    );
    assert.ok(line, `文档里找不到「生产依赖基线：<数字> …」这条声明（${DOC_REL}）`);

    const value = /生产依赖基线：\s*(\d+)\s*个?\s*漏洞?/.exec(line);
    assert.ok(value, "基线声明必须写成「生产依赖基线：0 个漏洞（…），核对日期：YYYY-MM-DD」");
    assert.equal(
        Number(value[1]),
        0,
        "生产依赖基线不是 0 —— 那是 high 级别的发现，不许用「有期限例外」糊过去",
    );

    const dated = /核对日期：\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    assert.ok(dated, "基线声明没带核对日期。没有日期的「0 漏洞」是永恒正确的废话");
    const checked = parseDay(dated[1], "生产依赖基线");
    const ageDays = Math.floor((Date.now() - checked) / DAY_MS);
    assert.ok(ageDays >= 0, `基线核对日期 ${dated[1]} 在未来 —— 别提前写还没做的核对`);
    assert.ok(
        ageDays <= BASELINE_MAX_AGE_DAYS,
        `生产基线声明已经 ${ageDays} 天没更新（上限 ${BASELINE_MAX_AGE_DAYS} 天）：` +
            "重跑 `npm audit --omit=dev --json`，确认仍是 0 之后把核对日期改成今天",
    );
});

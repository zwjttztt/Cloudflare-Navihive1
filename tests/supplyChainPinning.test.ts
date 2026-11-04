// tests/supplyChainPinning.test.ts
//
// 供应链固定的守卫（审查项 R18）。钉三件事：
//
//   1. **基础镜像与 compose 镜像按 digest 固定**。tag 是上游可以随时重推的指针：
//      `node:22-slim` 昨天指 A、今天指 B，内容换了，Dockerfile 一个字没改。
//      digest 是内容哈希，改内容就换 digest —— 这才叫「我上线的就是我验过的」。
//   2. **workflow 最小权限**。不写 `permissions:` 时用的是仓库设置里的 GITHUB_TOKEN
//      默认权限（历史上默认 read-write），代码里看不见、评审看不见。一个被投毒的
//      第三方 action 拿着它就能往 main 推提交。所以：顶层必须显式声明且只读，
//      写权限只能出现在**个别** job 上，并且登记在下面的 WRITE_ALLOW 里。
//   3. **例外必须有期限**。固定不了的东西（本地构建的 tag、自建滚动发布通道）
//      登记成例外，每条带 owner + until；到期即红，逼人回头看一眼。
//
// ⚠️ 允许清单写在**本文件**里，而不是从文档解析：坏掉的方式不同。
//    文档里的那张表是给人看的记录；这里的清单是判据。两边靠用例 5 对齐 ——
//    文档加了例外而代码没加（或反过来）都会红，所以不存在「改了文档忘了改代码」。
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
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const DAY_MS = 86_400_000;
const MAX_HORIZON_DAYS = 400;
const SHA256_RE = /@sha256:[0-9a-f]{64}(?:$|\s)/;
const DOC_REL = "docs/dependency-upgrade-assessment.md";

/** 检查一条「例外」登记的 owner / until 是否合格（每条都必须带，否则不算登记） */
function assertExceptionWindow(
    what: string,
    owner: string,
    until: string,
    why: string,
): void {
    assert.ok(owner.length >= 2, `${what}：例外没写责任人（owner）`);
    assert.match(why, /\S{4,}/, `${what}：例外没写理由（why）—— 没有理由的例外就是「懒得修」`);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
    assert.ok(m, `${what}：until 必须写成 YYYY-MM-DD，实际是「${until}」`);
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    assert.equal(
        new Date(ms).toISOString().slice(0, 10),
        until,
        `${what}：until 是个不存在的日期（${until}）`,
    );
    assert.ok(ms > Date.now(), `${what}：例外已于 ${until} 到期 —— 要么固定住，要么写明理由续期`);
    assert.ok(
        ms <= Date.now() + MAX_HORIZON_DAYS * DAY_MS,
        `${what}：until（${until}）超过 12 个月 — 例外不能无限期挂账`,
    );
}

// ============ 允许清单（固定不了的，带责任人 + 到期日） ============

interface ImageException {
    /** 相对仓库根的文件 */
    file: string;
    /** 文件里出现的**未固定**镜像引用（逐字，含 tag） */
    image: string;
    owner: string;
    until: string;
    why: string;
}

const IMAGE_EXCEPTIONS: ImageException[] = [
    {
        file: "docker-compose.yml",
        image: "navihive:latest",
        owner: "主理人",
        until: "2027-02-28",
        why:
            "本地 `build: .` 的产物：每次构建内容都不同，写死 digest 下一次重建就失效。" +
            "它的外部输入只有 Dockerfile 的 FROM（已钉 digest）",
    },
    {
        file: "deploy/kpanel-compose.yaml",
        image: "ghcr.io/zwjttztt/navihive:latest",
        owner: "主理人",
        until: "2027-02-28",
        why:
            "粘贴式部署模板 + 自建滚动发布通道：钉 digest 会把「几个月后照这份文件新装」" +
            "的机器冻在写模板那天。补偿控制：镜像只由 CI 通过后的 docker-publish 产出，" +
            "同 commit 另有 :<sha> tag 可钉",
    },
];

interface WriteException {
    /** `workflow 文件名:job id` */
    key: string;
    scope: string;
    owner: string;
    until: string;
    why: string;
}

/** 允许出现的 `contents: write` job —— 这是「能往仓库推提交」的那把钥匙 */
const WRITE_ALLOW: WriteException[] = [
    {
        key: "docker-publish.yml:merge",
        scope: "contents",
        owner: "主理人",
        until: "2027-02-28",
        why: "合成 multi-arch manifest 之后要打并推送 v${version} git tag（R18 从顶层收窄到这里）",
    },
];

// ============ Dockerfile ============

/** 每条 FROM 的镜像引用（`AS builder` 与 --platform 之类的 flag 都剥掉） */
function dockerfileFromRefs(): string[] {
    return read("Dockerfile")
        .split(/\r?\n/)
        .filter((line) => /^FROM\s/.test(line))
        .map((line) => {
            const tokens = line
                .replace(/^FROM\s+/, "")
                .split(/\s+/)
                .filter((token) => token.length > 0 && !token.startsWith("--"));
            return tokens[0] ?? "";
        });
}

const isPinned = (image: string): boolean => SHA256_RE.test(image);

const imageExceptionFor = (file: string, image: string): ImageException | undefined =>
    IMAGE_EXCEPTIONS.find((exception) => exception.file === file && exception.image === image);

test("Dockerfile 的每条 FROM 都固定了 digest（否则必须登记在允许清单里）", () => {
    const refs = dockerfileFromRefs();
    assert.ok(refs.length >= 1, "Dockerfile 里一条 FROM 都没有？");
    for (const ref of refs) {
        if (isPinned(ref)) continue;
        const exception = imageExceptionFor("Dockerfile", ref);
        assert.ok(
            exception,
            `Dockerfile 的 FROM「${ref}」没固定 digest：写成 ${ref}@sha256:<64 位小写十六进制>。` +
                "固定不了的话，在 IMAGE_EXCEPTIONS 里登记（带 owner + until + why）",
        );
        assertExceptionWindow(`Dockerfile FROM「${ref}」`, exception.owner, exception.until, exception.why);
    }
});

test("固定了 digest 的 FROM 同时保留可读 tag（别只剩一串哈希）", () => {
    for (const ref of dockerfileFromRefs()) {
        if (!isPinned(ref)) continue;
        const tagPart = ref.split("@")[0] ?? "";
        assert.match(
            tagPart,
            /:[^/:]+$/,
            `FROM「${ref}」只有 digest 没有 tag：保留 tag（如 node:22-slim@sha256:…）才看得出这是哪个版本`,
        );
        assert.match(
            ref,
            /@sha256:[0-9a-f]{64}$/,
            `FROM「${ref}」的 digest 形状不对（要 64 位小写十六进制，且必须在行尾）`,
        );
    }
});

// ============ compose ============

/** 某个 compose 文件里所有 `image:` 的值（注释行不算） */
function composeImages(rel: string): { line: number; image: string }[] {
    const out: { line: number; image: string }[] = [];
    read(rel)
        .split(/\r?\n/)
        .forEach((line, index) => {
            const m = /^\s*image:\s*(.+?)\s*$/.exec(line);
            if (!m) return;
            const value = (m[1] ?? "").replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
            if (value) out.push({ line: index + 1, image: value });
        });
    return out;
}

for (const rel of ["docker-compose.yml", "deploy/kpanel-compose.yaml"]) {
    test(`${rel} 的每个 image 都固定了 digest（否则必须登记在允许清单里）`, () => {
        const images = composeImages(rel);
        assert.ok(images.length > 0, `${rel} 里一个 image: 都没有 —— 这个守卫等于没跑`);
        for (const { line, image } of images) {
            if (isPinned(image)) continue;
            const exception = imageExceptionFor(rel, image);
            assert.ok(
                exception,
                `${rel}:${line} 的 image「${image}」是可变的：能解析 digest 就钉住` +
                    "（`image: 名:tag@sha256:…`）；钉不住的到 IMAGE_EXCEPTIONS 登记（带 owner + until + why）",
            );
            assertExceptionWindow(`${rel}:${line}「${image}」`, exception.owner, exception.until, exception.why);
        }
    });
}

test("允许清单本身没过期，且每一项都还对得上文件里真实存在的未固定镜像", () => {
    for (const exception of IMAGE_EXCEPTIONS) {
        assertExceptionWindow(
            `IMAGE_EXCEPTIONS「${exception.file}」→「${exception.image}」`,
            exception.owner,
            exception.until,
            exception.why,
        );
        const present = composeImages(exception.file).some(({ image }) => image === exception.image);
        assert.ok(
            present,
            `允许清单里的「${exception.image}」（${exception.file}）在文件里已经不存在了：` +
                "多半是固定住了 —— 那就要把这条例外从清单里删掉，别留着假装还有风险",
        );
    }
});

// ============ 文档 ↔ 代码 一致性 ============

const cellsOf = (line: string): string[] =>
    line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim().replace(/`/g, ""));

/** 取文档里某个**小节**（`##` 及以下、标题含 headingFragment）下面的第一张表 */
function docTable(headingFragment: string): { header: string[]; rows: string[][] } {
    const lines = read(DOC_REL).split(/\r?\n/);
    // 只认 `##` 及以下：H1 里也可能含同样的字，撞上它就会在正文里找不到表
    const start = lines.findIndex(
        (line) => /^#{2,6}\s/.test(line) && line.includes(headingFragment),
    );
    assert.ok(start >= 0, `${DOC_REL} 里找不到标题含「${headingFragment}」的小节`);
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.startsWith("#")) break;
        if (!line.trimStart().startsWith("|")) continue;
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

test("文档里的「供应链固定例外登记」与 IMAGE_EXCEPTIONS 是同一份清单", () => {
    // 这张表在核对时会被人翻到，所以它不能只是「曾经写过」。两边条目一一对应：
    // 位置列允许带括号说明（`docker-compose.yml`（navihive 服务）），按前缀比对。
    const table = docTable("供应链固定例外登记");
    const locationColumn = table.header.indexOf("位置");
    const targetColumn = table.header.indexOf("目标");
    const ownerColumn = table.header.indexOf("责任人");
    const untilColumn = table.header.indexOf("到期日");
    assert.ok(locationColumn >= 0 && targetColumn >= 0, "文档例外表缺「位置」/「目标」列");
    assert.ok(ownerColumn >= 0 && untilColumn >= 0, "文档例外表缺「责任人」/「到期日」列");
    assert.equal(
        table.rows.length,
        IMAGE_EXCEPTIONS.length,
        `文档里登记了 ${table.rows.length} 条，代码允许清单是 ${IMAGE_EXCEPTIONS.length} 条 —— 两边必须一致`,
    );

    for (const exception of IMAGE_EXCEPTIONS) {
        const row = table.rows.find(
            (cells) =>
                (cells[locationColumn] ?? "").startsWith(exception.file) &&
                (cells[targetColumn] ?? "") === exception.image,
        );
        assert.ok(
            row,
            `代码里允许了「${exception.file}」的「${exception.image}」，但文档的例外登记表里没有这一条 ——` +
                "例外必须同时写在文档（给人看）和本文件（给守卫看）",
        );
        assert.ok(
            (row[ownerColumn] ?? "").length >= 2,
            `文档例外表「${exception.image}」那行没写责任人`,
        );
        assert.match(
            row[untilColumn] ?? "",
            /^\d{4}-\d{2}-\d{2}$/,
            `文档例外表「${exception.image}」那行的到期日不是 YYYY-MM-DD`,
        );
    }
});

// ============ workflow 权限 ============

interface PermissionMap {
    [scope: string]: string;
}

interface ParsedWorkflow {
    top: PermissionMap | null;
    jobs: { id: string; own: PermissionMap | null }[];
}

/** 读一个 `key:` 下面的缩进映射（跳掉注释与空行；缩进回到 key 同级即结束） */
function readBlock(lines: string[], keyIndex: number, keyIndent: number): PermissionMap {
    const out: PermissionMap = {};
    for (let i = keyIndex + 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const indent = line.length - line.trimStart().length;
        if (indent <= keyIndent) break;
        const kv = /^([A-Za-z-]+):\s*(\S+)\s*$/.exec(trimmed);
        if (kv) out[kv[1] ?? ""] = kv[2] ?? "";
    }
    return out;
}

/**
 * 极简 workflow 解析：只认这两份文件里实际出现的写法（2 空格缩进的 job、
 * `permissions:` 的映射形式与 `permissions: read-all` 的内联形式）。
 *
 * ⚠️ 故意不引入 yaml 依赖：`yaml` 在本仓只是 wrangler 的传递依赖，哪天上游换了
 * 实现，这个守卫会连带报「模块找不到」—— 守卫的依赖面越小越可靠。
 * 代价是写法超出上面这两种时要同步改这里（改的时候报错信息会说清楚）。
 */
function parseWorkflow(rel: string): ParsedWorkflow {
    const lines = read(rel).split(/\r?\n/);

    let top: PermissionMap | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const inline = /^permissions:\s*(\S+)\s*$/.exec(line);
        if (inline) {
            top = { "*": inline[1] ?? "" };
            break;
        }
        if (/^permissions:\s*$/.test(line)) {
            top = readBlock(lines, i, 0);
            break;
        }
    }

    const jobsStart = lines.findIndex((line) => /^jobs:\s*$/.test(line));
    assert.ok(jobsStart >= 0, `${rel} 里没有 jobs: 段`);

    const jobs: { id: string; own: PermissionMap | null }[] = [];
    let current: { id: string; start: number } | null = null;

    const ownOf = (from: number, to: number): PermissionMap | null => {
        for (let i = from; i < to; i++) {
            const line = lines[i] ?? "";
            const inline = /^ {4}permissions:\s*(\S+)\s*$/.exec(line);
            if (inline) return { "*": inline[1] ?? "" };
            if (/^ {4}permissions:\s*$/.test(line)) return readBlock(lines, i, 4);
        }
        return null;
    };

    for (let i = jobsStart + 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        if (line.length - line.trimStart().length === 0) break; // jobs 段结束
        const jobKey = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (!jobKey) continue;
        if (current) jobs.push({ id: current.id, own: ownOf(current.start, i) });
        current = { id: jobKey[1] ?? "", start: i };
    }
    if (current) jobs.push({ id: current.id, own: ownOf(current.start, lines.length) });

    return { top, jobs };
}

const WORKFLOWS = [
    "ci.yml",
    "deploy.yml",
    "docker-publish.yml",
    "prod-smoke.yml",
    "secret-history.yml",
    "visual-regression.yml",
];

test("每个 workflow 都有顶层 permissions，且顶层是只读的", () => {
    for (const name of WORKFLOWS) {
        const { top } = parseWorkflow(`.github/workflows/${name}`);
        assert.ok(
            top,
            `${name} 没写顶层 permissions：那用的是仓库设置里的默认 GITHUB_TOKEN 权限` +
                "（躺在 Settings 里，评审看不见，历史上默认 read-write）。显式写 `permissions: contents: read`",
        );
        for (const [scope, value] of Object.entries(top)) {
            assert.notEqual(
                value,
                "write-all",
                `${name} 顶层写了 write-all —— 这是「把钥匙插在门上」，任何第三方 action 都能改仓库`,
            );
            assert.notEqual(
                value,
                "write",
                `${name} 顶层的 ${scope}: write 太宽 —— 写权限只能下沉到真正需要的那个 job`,
            );
        }
        assert.ok(
            "contents" in top || "*" in top,
            `${name} 顶层 permissions 里没写 contents（checkout 要靠它）`,
        );
    }
});

test("每个 workflow 的每个 job 都有生效的 permissions（顶层有默认值也算）", () => {
    for (const name of WORKFLOWS) {
        const { top, jobs } = parseWorkflow(`.github/workflows/${name}`);
        assert.ok(jobs.length > 0, `${name} 里一个 job 都没解析出来 —— 解析器或文件结构变了`);
        for (const job of jobs) {
            const effective = job.own ?? top;
            assert.ok(
                effective,
                `${name} 的 job「${job.id}」既没有 job 级 permissions，顶层也没有默认值`,
            );
            assert.ok(
                "contents" in effective || "*" in effective,
                `${name} 的 job「${job.id}」的 permissions 里没有 contents：` +
                    "job 级 permissions 是整体覆盖顶层的，漏了 contents 会让 checkout 403",
            );
        }
    }
});

test("能往仓库推提交的 contents: write 只出现在登记过的 job 上", () => {
    // 这是 R18 的核心收窄：改动前 docker-publish.yml 的顶层是 contents: write，
    // 于是 gate / notify 这两个只读 job 也各握着一把能改仓库的钥匙。
    const keys = new Set(WRITE_ALLOW.map((entry) => entry.key));
    for (const entry of WRITE_ALLOW) {
        assertExceptionWindow(
            `WRITE_ALLOW「${entry.key}」`,
            entry.owner,
            entry.until,
            entry.why,
        );
    }

    let seenAllowlisted = 0;
    for (const name of WORKFLOWS) {
        const { top, jobs } = parseWorkflow(`.github/workflows/${name}`);
        const holders: { key: string; scope: string }[] = [];
        if (top && (top["*"] === "write-all" || top.contents === "write")) {
            holders.push({ key: `${name}:<顶层>`, scope: "contents" });
        }
        for (const job of jobs) {
            const own = job.own;
            if (!own) continue;
            if (own["*"] === "write-all" || own.contents === "write") {
                holders.push({ key: `${name}:${job.id}`, scope: "contents" });
            }
        }
        for (const holder of holders) {
            assert.ok(
                keys.has(holder.key),
                `${holder.key} 拿到了 contents: write（能往 main 推提交）。` +
                    "只给真正需要的 job；确实需要就登进 WRITE_ALLOW（带 owner + until + why）",
            );
            if (keys.has(holder.key)) seenAllowlisted += 1;
        }
    }

    // 反向：清单里登记的 job 一旦不再写，条目就该删掉（否则清单会越攒越吓人）
    assert.ok(
        seenAllowlisted > 0,
        "WRITE_ALLOW 里登记的 job 一个都没在写仓库了 —— 把过期的条目删掉",
    );
});

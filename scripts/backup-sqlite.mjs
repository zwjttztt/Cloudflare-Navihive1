#!/usr/bin/env node
// scripts/backup-sqlite.mjs
//
// NaviHive 自托管形态下的 SQLite 本地快照脚本（DATA-10）。
//
// 用途：在「宿主 crontab 的本地兜底」这一层（见 deploy/selfhost.md 第七节 / 7.1 层次二）
// 提供一个仓库自带、零依赖、可直接塞进 crontab 的备份工具。它一次做齐三件事：
//
//   1) 在线备份：用 SQLite 的 VACUUM INTO 把现役库打成一份完整的单文件快照。
//      WAL 模式下直接 cp 主文件会丢掉未 checkpoint 的数据（见 7.1 注释），VACUUM INTO
//      读的是已提交的一致快照，包含 WAL 里还没落盘的那部分。
//   2) 校验：打开快照跑 PRAGMA integrity_check（结构完整），并比对快照与现役库的
//      表数量一致（防止备错了文件 / 备到空档期）。
//   3) 打印快照的 SHA-256 校验和，方便异地拷贝后核对文件没被截断或损坏。
//
// 零依赖：只用 node: 内置模块 + node:sqlite（项目 server/ 已经依赖 node:sqlite，
// 见 server/sqlite-d1.ts）。优先走 node:sqlite；本机没装 sqlite3 CLI 时也能用，
// 这正是 Docker 接法（容器内无 sqlite3）想要的。
//
// 设计取舍与「为什么不能直接 cp」详见 deploy/selfhost.md 第七节。本脚本是那一节
// 「层次二：宿主 crontab 的本地兜底」的即用实现 —— 那里原本写「backup.sh 仓库里没有，
// 要你自己写一个」，现在有了。
//
// 用法见下方 --help，或 deploy/selfhost.md 第七节的「备份脚本」小节。

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    unlinkSync,
} from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 参数解析（零依赖，手写）
// ---------------------------------------------------------------------------

/** 把 --key value / --key=value / --flag 解析成对象 */
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) {
            out._.push(a);
            continue;
        }
        const eq = a.indexOf("=");
        if (eq !== -1) {
            const k = a.slice(2, eq);
            out[k] = a.slice(eq + 1);
            continue;
        }
        const k = a.slice(2);
        const next = argv[i + 1];
        // 下一个是值（不是另一个 -- 开头的旗标）
        if (next !== undefined && !next.startsWith("--")) {
            out[k] = next;
            i++;
        } else {
            out[k] = true; // 布尔旗标
        }
    }
    return out;
}

function printHelp() {
    const help = `
NaviHive SQLite 本地快照脚本（DATA-10）

对现役 SQLite 库做一次「VACUUM INTO」在线备份，并校验完整性、打印 SHA-256。

用法：
  node scripts/backup-sqlite.mjs [选项]

选项：
  --db <路径>        现役库文件路径。
                    优先级：--db > 环境变量 DB_PATH > 环境变量 NAVIHIVE_DB >
                    默认 ./data/navihive.db（与 server/entry.ts 的 DB_FILE 默认一致）。
  --out <目录>      备份落盘目录。默认与现役库同目录。
                    可用环境变量 BACKUP_DIR 覆盖。
  --check           只检查、不备份：扫描备份目录里最新的快照文件，
                    报告「距上次本地快照 N 天」。没有任何快照时提示立即备份。
  --days <N>        --check 模式下用于「提示」的阈值天数（默认 30）。
                    仅影响 --check 的输出文案，不影响备份行为。
  --quiet           备份成功时只打印最少信息（仍会打印 SHA-256 与校验结论）。
  --help, -h        显示本帮助并退出。

环境变量（与命令行等价，便于 crontab 里配置）：
  DB_PATH / NAVIHIVE_DB   现役库路径（见 --db）
  BACKUP_DIR              备份目录（见 --out）

示例：
  # 默认备份 ./data/navihive.db，快照落 ./data/
  node scripts/backup-sqlite.mjs

  # 指定库与备份目录
  node scripts/backup-sqlite.mjs --db /srv/navihive/data/navihive.db --out /backup

  # 只报告距上次快照多少天（适合塞进 crontab 顺带自查）
  node scripts/backup-sqlite.mjs --check

说明：
  - 备份文件名形如 <库名 stem>-YYYY-MM-DD-HHMMSS.db（例如 navihive-2026-11-01-153000.db）。
  - VACUUM INTO 要求目标文件不存在，脚本会先删掉同名目标（时间戳精确到秒，实际不会撞）。
  - 校验失败或现役库不存在时以非零退出码结束，方便 crontab / CI 判定成败。

更多：deploy/selfhost.md 第七节「备份与恢复」的「备份脚本」小节。
`.trimStart();
    console.log(help);
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

function resolveDbPath(args) {
    if (args.db) return path.resolve(args.db);
    if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
    if (process.env.NAVIHIVE_DB) return path.resolve(process.env.NAVIHIVE_DB);
    return path.resolve("./data/navihive.db"); // 与 server/entry.ts 默认一致
}

function resolveOutDir(args, dbPath) {
    const dir = args.out || process.env.BACKUP_DIR || path.dirname(dbPath);
    return path.resolve(dir);
}

/** 把路径安全地塞进 SQL 字符串字面量：单引号翻倍，反斜杠转成正斜杠（SQLite 在 Windows 也认 /） */
function sqlLiteral(p) {
    return p.replace(/\\/g, "/").replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

function timestamp() {
    // YYYY-MM-DD-HHMMSS（本地时间，和 crontab / 日志同一时区，便于对照）
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
        d.getFullYear() +
        "-" + pad(d.getMonth() + 1) +
        "-" + pad(d.getDate()) +
        "-" + pad(d.getHours()) +
        pad(d.getMinutes()) +
        pad(d.getSeconds())
    );
}

// ---------------------------------------------------------------------------
// 备份 + 校验
// ---------------------------------------------------------------------------

async function doBackup(dbPath, outDir) {
    if (!existsSync(dbPath)) {
        console.error(`✖ 现役库不存在：${dbPath}`);
        console.error("  服务还没启动建库？或 DB_PATH / NAVIHIVE_DB 指错了？先确认路径再备份。");
        process.exit(1);
    }

    mkdirSync(outDir, { recursive: true });

    const stem = path.basename(dbPath).replace(/\.[^.]+$/, "") || "navihive";
    const target = path.join(outDir, `${stem}-${timestamp()}.db`);

    if (existsSync(target)) {
        // 时间戳精确到秒，正常情况下不会撞；撞了就删掉重来（这是我们要重建的快照）
        unlinkSync(target);
    }

    // 1) 在线备份：VACUUM INTO
    const src = new DatabaseSync(dbPath);
    try {
        src.exec("PRAGMA busy_timeout = 5000"); // 服务持写锁时等它，而不是立刻 SQLITE_BUSY
        src.exec(`VACUUM INTO '${sqlLiteral(target)}'`);
    } finally {
        src.close();
    }

    // 2) 校验：integrity_check + 表数量与现役库一致
    const bak = new DatabaseSync(target, { readOnly: true });
    let integrity = "unknown";
    let bakTables = -1;
    let srcTables = -1;
    try {
        integrity = bak.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "unknown";
        bakTables = Number(
            bak.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get()?.c ?? -1
        );
    } finally {
        bak.close();
    }

    // 现役库的表数量（只读连接，避免干扰服务）
    const srcRo = new DatabaseSync(dbPath, { readOnly: true });
    try {
        srcTables = Number(
            srcRo.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get()?.c ?? -1
        );
    } finally {
        srcRo.close();
    }

    // 3) SHA-256
    const sha = await sha256File(target);
    const sizeBytes = statSync(target).size;

    // 结论
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    const ok = integrity === "ok" && bakTables >= 0 && bakTables === srcTables;
    console.log(`✓ 备份完成：${target}`);
    console.log(`  大小      ${sizeBytes} 字节（${sizeMb} MB）`);
    console.log(`  完整性    PRAGMA integrity_check = ${integrity}`);
    console.log(`  表数量    快照 ${bakTables} / 现役 ${srcTables}${bakTables === srcTables ? "（一致）" : "（不一致！）"}`);
    console.log(`  SHA-256   ${sha}`);
    if (!ok) {
        console.error("✖ 校验未通过：备份可能不可用，请勿依赖这份快照。");
        process.exit(1);
    }
    console.log("✓ 校验通过（结构完整 + 表数量与现役库一致）。");
    return { target, sha, sizeBytes, integrity, bakTables, srcTables };
}

// ---------------------------------------------------------------------------
// --check：距上次本地快照多少天
// ---------------------------------------------------------------------------

function doCheck(dbPath, outDir, warnDays) {
    if (!existsSync(outDir)) {
        console.log(`未找到备份目录：${outDir}（还没有任何本地快照，建议立即运行一次备份）`);
        return;
    }
    const stem = path.basename(dbPath).replace(/\.[^.]+$/, "") || "navihive";
    // 只认本脚本产出的快照：<stem>-<时间戳>.db
    const re = new RegExp(
        "^" + stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-.+\\.db$"
    );
    const files = readdirSync(outDir).filter((f) => re.test(f));
    if (files.length === 0) {
        console.log(`备份目录 ${outDir} 下没有任何 ${stem}-*.db 快照（建议立即运行一次备份）。`);
        return;
    }
    const newest = Math.max(...files.map((f) => statSync(path.join(outDir, f)).mtimeMs));
    const days = Math.floor((Date.now() - newest) / 86_400_000);
    const newestFile = files
        .map((f) => ({ f, m: statSync(path.join(outDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0].f;
    console.log(`最新本地快照：${newestFile}（mtime ${new Date(newest).toISOString()}）`);
    console.log(`距上次本地快照 ${days} 天（阈值 ${warnDays} 天）。`);
    if (days >= warnDays) {
        console.log(`⚠️ 已超过 ${warnDays} 天未更新本地快照，建议运行 node scripts/backup-sqlite.mjs 备份。`);
    } else {
        console.log("本地快照在阈值内，无需担心。");
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help || args.h) {
        printHelp();
        process.exit(0);
    }

    const dbPath = resolveDbPath(args);
    const outDir = resolveOutDir(args, dbPath);
    const warnDays = Number(args.days || process.env.BACKUP_WARN_DAYS || "30");

    if (args.check) {
        doCheck(dbPath, outDir, warnDays);
        process.exit(0);
    }

    if (!args.quiet) {
        console.log(`现役库   ${dbPath}`);
        console.log(`备份目录 ${outDir}`);
    }

    await doBackup(dbPath, outDir);
    process.exit(0);
}

main().catch((err) => {
    console.error("✖ 备份脚本异常：", err instanceof Error ? err.message : String(err));
    process.exit(1);
});

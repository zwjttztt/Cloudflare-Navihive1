// script/bump-version-lib.mjs
// 版本号跳变的纯逻辑（不碰 git、不碰文件系统）—— 单测在 tests/bumpVersion.test.ts。
//
// 为什么单独一个文件：bump-version.mjs 的主流程要调 git，而单测是 esbuild 打包后
// 在 node:test 里跑的，脚本会被内联进测试 bundle —— 放在同一个文件里，
// 「只有直接执行才跑主流程」的守卫会被打包绕过（argv[1] 恰好等于 bundle 路径，
// 实测 main() 在 import 时执行、还把 git 命令拖进来崩掉）。纯函数拆开，
// 测试只 import 这个文件，零副作用，打包内联也无所谓。
//
// 档位语义（用户需求：「v0.1.0 随着更新部署自动变动，根据改动范围大小调整变动位数」）：
//   patch：≤ 5 个文件 且 ≤ 200 行（增+删）→ 末位动
//   minor：≤ 20 个文件 且 ≤ 1200 行       → 中位动、末位归零
//   major：超出上面任一                    → 首位动、其余归零

/** 档位阈值（文件数, 总行数）—— 改这里就是改「多大的改动算大」 */
export const THRESHOLDS = { patch: { files: 5, lines: 200 }, minor: { files: 20, lines: 1200 } };

/** 改动规模 → 档位。任一维度超出 minor 线就是 major（大改不该被文件少糊弄过去） */
export function levelOf(files, lines) {
    if (files <= THRESHOLDS.patch.files && lines <= THRESHOLDS.patch.lines) return "patch";
    if (files <= THRESHOLDS.minor.files && lines <= THRESHOLDS.minor.lines) return "minor";
    return "major";
}

/** 按档位跳变。语义版本三段，跳中位/首位时低位归零 */
export function bumpSemver(version, level) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
    if (!m) throw new Error(`看不懂的版本号：${version}（期望 major.minor.patch）`);
    let major = Number(m[1]);
    let minor = Number(m[2]);
    let patch = Number(m[3]);
    if (level === "patch") patch += 1;
    if (level === "minor") {
        minor += 1;
        patch = 0;
    }
    if (level === "major") {
        major += 1;
        minor = 0;
        patch = 0;
    }
    return `${major}.${minor}.${patch}`;
}

/**
 * 把新版本号写进 package.json 的文本（只换 version 那一行的值，其余字节不动）。
 * 直接 JSON.parse → stringify 会重排格式、制造一整文件 diff，把「改了版本」这件事
 * 淹没在格式噪声里 —— 而版本 diff 是要给人看的审计轨迹。
 */
export function applyVersionToPackageJson(raw, next) {
    const re = /("version"\s*:\s*")[^"]*(")/;
    if (!re.test(raw)) throw new Error("package.json 里找不到 version 字段");
    return raw.replace(re, `$1${next}$2`);
}

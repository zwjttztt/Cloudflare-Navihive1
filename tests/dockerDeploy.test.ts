// tests/dockerDeploy.test.ts
//
// Docker 部署件的行为钉子。镜像和 compose 都是「改坏了没有任何东西会报错」的那类文件：
//   - runtime 忘了 NAVIHIVE_HOST=0.0.0.0 → 容器内只听 127.0.0.1，端口映射全都打不通，
//     而容器状态是 healthy、日志一切正常；
//   - COPY 路径写错 → 构建期就炸，但改产物目录名时容易只改一边；
//   - .dockerignore 漏了 data/ 或 .env → 本地开发库/密钥被烙进镜像层，推仓库就等于泄密；
//   - compose 漏了 AUTH_SECRET 的 :? → 服务起得来但登录必然失败（fail-closed），
//     表现为「部署成功了但登不进去」。
// 这些只能钉在这里。⚠️ 本测试只钉文件内容，镜像能否真构建取决于 Dockerfile 里的命令
// （那些命令与 npm run start:selfhost 前面的步骤一致，由构建本身验证）。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

/** 取 Dockerfile 的最后一个 Stage（运行阶段）——多行字符串按 FROM 切 */
function runtimeStage(dockerfile: string): string {
    const stages = dockerfile.split(/^FROM /m);
    assert.ok(stages.length >= 2, "Dockerfile 应该是多阶段构建（至少 builder + runtime）");
    return stages[stages.length - 1];
}

// ============ Dockerfile ============

test("Dockerfile 存在且两个 Stage 都用 node:24", () => {
    assert.ok(existsSync(path.join(ROOT, "Dockerfile")), "仓库根没有 Dockerfile");
    const df = read("Dockerfile");
    const froms = df.match(/^FROM .+$/gm) ?? [];
    assert.equal(froms.length, 2, `预期恰好两个 Stage（builder + runtime），实际：${froms.join(" | ")}`);
    for (const line of froms) {
        // node:24 LTS：node:sqlite 免实验 flag 的最低主线版本，与 deploy/selfhost.md 的建议一致
        assert.match(line, /node:24-slim/, `Stage 基础镜像不是 node:24-slim：${line}`);
    }
});

test("Dockerfile runtime 设 NAVIHIVE_HOST=0.0.0.0（否则端口映射打不通）", () => {
    const rt = runtimeStage(read("Dockerfile"));
    // entry.ts 的默认值是 127.0.0.1 —— 容器里那就是「只有容器自己够得着」，
    // docker -p 映射全数失效，且容器看起来完全正常。这是最阴的一个坑，必须钉死。
    assert.match(rt, /NAVIHIVE_HOST[= ]0\.0\.0\.0/, "runtime Stage 没有把 NAVIHIVE_HOST 设成 0.0.0.0");
});

test("Dockerfile 只带构建产物进 runtime，且 COPY 路径与真实产物一致", () => {
    const rt = runtimeStage(read("Dockerfile"));
    assert.match(rt, /COPY --from=builder \/app\/dist\/client \.\/dist\/client/, "没拷 dist/client（静态资源 + _headers）");
    assert.match(rt, /COPY --from=builder \/app\/dist-server\/entry\.mjs \.\/dist-server\/entry\.mjs/, "没拷 dist-server/entry.mjs（服务本体）");
    // 自包含单文件：runtime 里不应该出现 node_modules 或源码目录
    assert.doesNotMatch(rt, /node_modules/, "runtime 不该出现 node_modules（产物是自包含的）");
    assert.doesNotMatch(rt, /COPY --from=builder \/app\/(worker|server|src|tests)/, "runtime 不该拷源码目录");
});

test("Dockerfile 的构建命令就是 npm run build + build:server", () => {
    const builder = read("Dockerfile").split(/^FROM /m)[1];
    assert.match(builder, /npm ci/, "builder 没跑 npm ci");
    assert.match(builder, /npm run build && npm run build:server/, "builder 没跑 build + build:server（与 start:selfhost 前两步一致）");
});

test("Dockerfile 以非 root 运行并挂数据卷", () => {
    const rt = runtimeStage(read("Dockerfile"));
    assert.match(rt, /^USER node$/m, "runtime 没有 USER node（最小权限）");
    assert.match(rt, /^VOLUME \/app\/data$/m, "runtime 没有声明 /app/data 卷（库和附件会随容器销毁）");
});

test("Dockerfile 的 EXPOSE 与 entry.ts 的 NAVIHIVE_PORT 默认值一致", () => {
    const entry = read(path.join("server", "entry.ts"));
    const m = entry.match(/env\("NAVIHIVE_PORT", "(\d+)"\)/);
    assert.ok(m, "entry.ts 里找不到 NAVIHIVE_PORT 的默认值");
    const rt = runtimeStage(read("Dockerfile"));
    assert.match(rt, new RegExp(`^EXPOSE ${m[1]}$`, "m"), `EXPOSE 与 NAVIHIVE_PORT 默认值（${m[1]}）不一致`);
});

test("Dockerfile 静音 node:sqlite 的 ExperimentalWarning", () => {
    // 与 npm run start:selfhost 的 --disable-warning=ExperimentalWarning 保持一致：
    // 不静音的话每条日志前缀都带警告，排障时全是噪音。
    assert.match(read("Dockerfile"), /--disable-warning=ExperimentalWarning/, "CMD 没带 --disable-warning=ExperimentalWarning");
});

test("Dockerfile 的 HEALTHCHECK 打 /api/init（公开、真读库）", () => {
    const rt = runtimeStage(read("Dockerfile"));
    assert.match(rt, /HEALTHCHECK/, "runtime 没有 HEALTHCHECK");
    assert.match(rt, /\/api\/init/, "探活没打 /api/init");
    // 必须打 127.0.0.1：容器内自测，走外面映射等于把探活暴露成公网入口
    assert.match(rt, /http:\/\/127\.0\.0\.1:/, "探活地址不是 127.0.0.1");
});

// ============ .dockerignore ============

test(".dockerignore 排除依赖、产物、数据与密钥", () => {
    assert.ok(existsSync(path.join(ROOT, ".dockerignore")), "仓库根没有 .dockerignore");
    const lines = read(".dockerignore").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    for (const required of ["node_modules", "dist", "dist-server", "data", ".env"]) {
        assert.ok(lines.includes(required), `.dockerignore 没排除 ${required}`);
    }
    // 反过来的断言同样重要：模板文件要能进镜像/上下文（compose 文档指向它）
    assert.ok(!lines.includes(".env.example"), ".dockerignore 不该排除 .env.example");
});

// ============ docker-compose.yml ============

test("compose 强制要求 AUTH_SECRET（缺了就直接失败，别起一个登不进去的服务）", () => {
    const compose = read("docker-compose.yml");
    // ${AUTH_SECRET:?...} 是 compose 的「必填」语法；写成 ${AUTH_SECRET:-} 会静默起服务
    assert.match(compose, /\$\{AUTH_SECRET:\?/, "compose 没有用 ${AUTH_SECRET:?…} 强制要求密钥");
});

test("compose 把数据落进命名卷", () => {
    const compose = read("docker-compose.yml");
    assert.match(compose, /navihive-data:\/app\/data/, "compose 没把命名卷挂到 /app/data");
    assert.match(compose, /^volumes:\s*$/m, "compose 没有声明 volumes 段");
    assert.match(compose, /^\s{2}navihive-data:\s*$/m, "compose 没有定义 navihive-data 卷");
});

test("compose 端口只绑宿主机回环（TLS 交给前面的反代）", () => {
    const compose = read("docker-compose.yml");
    assert.match(compose, /"127\.0\.0\.1:\$\{NAVIHIVE_PORT:-8787\}:8787"/, "compose 的端口映射没绑 127.0.0.1");
});

test("compose 显式写 NAVIHIVE_HOST=0.0.0.0（防 Dockerfile 默认值被改）", () => {
    const compose = read("docker-compose.yml");
    assert.match(compose, /NAVIHIVE_HOST:\s*0\.0\.0\.0/, "compose 没显式设 NAVIHIVE_HOST=0.0.0.0");
});

test("compose 开日志轮转（API 访问日志不轮转能把小 VPS 磁盘写满）", () => {
    const compose = read("docker-compose.yml");
    assert.match(compose, /max-size/, "compose 没配日志轮转 max-size");
    assert.match(compose, /max-file/, "compose 没配日志轮转 max-file");
});

test("compose 单副本 + 崩溃自愈", () => {
    const compose = read("docker-compose.yml");
    assert.match(compose, /restart:\s*unless-stopped/, "compose 没配 restart: unless-stopped");
    assert.match(compose, /replicas:\s*1/, "compose 没锁单副本（SQLite 单写者，多副本各写各的库）");
});

// ============ 密钥卫生 ============

test(".env 不进版本库，.env.example 进", () => {
    const ignore = read(".gitignore");
    assert.match(ignore, /^\.env$/m, ".gitignore 没有忽略 .env");
    assert.match(ignore, /^\*\*\/\.env$/m, ".gitignore 没有忽略嵌套的 .env");
    assert.ok(existsSync(path.join(ROOT, ".env.example")), "没有 .env.example 模板");
    // 模板里必须留出 AUTH_SECRET 的位置，但绝不能真有值
    const example = read(".env.example");
    assert.match(example, /^AUTH_SECRET=\s*$/m, ".env.example 没有空的 AUTH_SECRET 行");
});

test(".gitattributes 钉住 Docker 部署件的 LF 行尾", () => {
    // core.autocrlf=true 的 Windows 检出会把它们变成 CRLF：CRLF 的 .env 会把 \r
    // 一起读进 AUTH_SECRET（令牌签名静默错），Dockerfile/compose 的行尾污染同理。
    const attrs = read(".gitattributes");
    for (const f of ["Dockerfile", ".dockerignore", "docker-compose.yml", ".env.example"]) {
        assert.match(attrs, new RegExp(`^${f.replace(".", "\\.")} text eol=lf$`, "m"), `.gitattributes 没给 ${f} 钉 eol=lf`);
    }
});

// tests/upgradeCompose.test.ts
// 「网页一键升级」里两个纯函数的守卫：部署坐标解析 + helper 命令拼装。
//
// 为什么值得单独测：这两段逻辑 2026-11 之前混在 server/entry.ts（1500+ 行）里，
// 和「连 docker.sock」的代码缠在一起，单测一个字符都碰不到 —— 覆盖率 0/0/0。
// 而它们恰恰是**只在线上炸过一次**的那种代码：
//   · v4.3.0/v4.3.1 把目录挂在 /compose，compose 于是把 /compose 写进新容器的
//     working_dir 标签 → 第二次升级必然失败（详见 compose.ts 的长注释）；
//   · helper 里的 `docker compose` 要的是 `tcp://` 而不是 `http://`（dockerApi.ts）。
// 拆出来之后，这里逐条钉住「哪些输入必须被拒」「命令里必须有什么」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readComposeInfo, upgraderCommand } from "../server/upgrade/compose";

const LABELS = (over: Record<string, string> = {}): Record<string, string> => ({
    "com.docker.compose.project": "navihive",
    "com.docker.compose.project.working_dir": "/srv/navihive",
    "com.docker.compose.project.config_files": "/srv/navihive/docker-compose.yml,/srv/navihive/docker-compose.override.yml",
    ...over,
});

test("readComposeInfo：正常标签 → 工程名 / 工作目录 / 配置文件全拿到", () => {
    const info = readComposeInfo(LABELS(), "");
    assert.ok(info, "正常标签不该返回 null");
    assert.equal(info.project, "navihive");
    assert.equal(info.workingDir, "/srv/navihive");
    assert.deepEqual(info.files, [
        "/srv/navihive/docker-compose.yml",
        "/srv/navihive/docker-compose.override.yml",
    ]);
    // network 由调用方从容器 NetworkSettings 填，解析阶段恒空
    assert.equal(info.network, "");
});

test("readComposeInfo：工作目录末尾的斜杠会被削掉（否则拼出来是双斜杠）", () => {
    const info = readComposeInfo(LABELS({ "com.docker.compose.project.working_dir": "/srv/navihive/" }), "");
    assert.equal(info?.workingDir, "/srv/navihive");
});

test("readComposeInfo：没有标签 / 相对路径 / 空串一律 null —— 宁可明确报错，不假装成功", () => {
    assert.equal(readComposeInfo({}, ""), null, "纯 docker run 起的没有 compose 标签");
    assert.equal(
        readComposeInfo(LABELS({ "com.docker.compose.project.working_dir": "srv/navihive" }), ""),
        null,
        "相对路径没法当 bind 源",
    );
    assert.equal(
        readComposeInfo(LABELS({ "com.docker.compose.project.working_dir": "" }), ""),
        null,
        "空串同样没法 bind",
    );
});

test("readComposeInfo：/compose 是旧版污染标记，必须拒（这正是「第二次升级必失败」的根因）", () => {
    const polluted = LABELS({ "com.docker.compose.project.working_dir": "/compose" });
    assert.equal(readComposeInfo(polluted, ""), null, "没配 NAVIHIVE_COMPOSE_DIR 时必须拒掉 /compose");

    // 用户显式配了真实目录 → 以配置为准，污染标签被绕过
    const info = readComposeInfo(polluted, "/srv/navihive");
    assert.equal(info?.workingDir, "/srv/navihive");
});

test("readComposeInfo：NAVIHIVE_COMPOSE_DIR 的优先级高于容器标签", () => {
    const info = readComposeInfo(LABELS(), "/opt/stack");
    assert.equal(info?.workingDir, "/opt/stack");
});

test("upgraderCommand：工作目录内的配置文件被拼成 -f，目录外的被丢掉", () => {
    const info = readComposeInfo(
        LABELS({
            "com.docker.compose.project.config_files":
                "/srv/navihive/docker-compose.yml,/elsewhere/docker-compose.yml",
        }),
        "",
    );
    assert.ok(info);
    const cmd = upgraderCommand(info, "navihive");
    assert.ok(cmd.includes('CFG="-f /srv/navihive/docker-compose.yml"'), "工作目录内的文件要进 CFG");
    assert.ok(!cmd.includes("/elsewhere/docker-compose.yml"), "工作目录外的文件必须被过滤");
});

test("upgraderCommand：必须 cd 到宿主原路径、用 --force-recreate、不用管道取退出码", () => {
    const info = readComposeInfo(LABELS(), "");
    assert.ok(info);
    const cmd = upgraderCommand(info, "navihive");

    assert.ok(cmd.includes('cd "/srv/navihive"'), "必须 cd 到宿主原路径（不是 /compose）");
    assert.ok(cmd.includes("up -d --force-recreate"), "必须是 force-recreate，restart 不重新解析 :latest");
    assert.ok(cmd.includes("-p navihive"), "必须带 compose 工程名");
    // $? 必须来自 docker compose 本身：加管道就会拿到管道的退出码
    assert.ok(cmd.includes('OUT=$(docker compose'), "输出要存变量，别用管道接住退出码");
    assert.ok(cmd.includes("CODE=$?"), "退出码要单独取");
    // 回归锚点：挂载点写成 /compose 会让下一轮捡到污染标签
    assert.ok(!/cd\s+"?\/compose/m.test(cmd), "绝不能 cd 到 /compose");
});

test("upgraderCommand：两条前置自检各自有独立退出码（21 找不到配置 / 22 没挂 docker CLI）", () => {
    const info = readComposeInfo(LABELS(), "");
    assert.ok(info);
    const cmd = upgraderCommand(info, "navihive");
    assert.ok(cmd.includes("exit 21"), "找不到 compose 配置文件要 exit 21");
    assert.ok(cmd.includes("exit 22"), "宿主机 docker CLI 不可用要 exit 22");
    assert.ok(cmd.includes("/usr/bin/docker"), "自检要指向实际挂进来的路径");
});

test("upgraderCommand：空 config_files 时退回扫四个惯用文件名", () => {
    const info = readComposeInfo(LABELS({ "com.docker.compose.project.config_files": "" }), "");
    assert.ok(info);
    assert.deepEqual(info.files, [], "没有配置文件标签时 files 为空");
    const cmd = upgraderCommand(info, "navihive");
    for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
        assert.ok(cmd.includes(`/srv/navihive/${name}`), `兜底扫描要包含 ${name}`);
    }
});

test("upgraderCommand：健康门禁与回滚锚点必须在命令里（缺一个就等于放弃回滚能力）", () => {
    const info = readComposeInfo(LABELS(), "");
    assert.ok(info);
    const cmd = upgraderCommand(info, "navihive");
    // 回滚锚点：recreate 之前要 tag 住当前镜像
    assert.ok(cmd.includes("docker tag"), "重建前要 tag 住旧镜像，否则回滚无镜可退");
    assert.ok(cmd.includes("docker inspect --format='{{.Image}}' navihive"), "锚点要 inspect 被升级的那个容器");
    // 健康门禁：不健康就回滚，且回滚终态不能报「完成」
    assert.ok(cmd.includes("rolled_back") || cmd.includes("40"), "健康门禁要能表达 rolled_back");
    assert.ok(cmd.includes("rollback_failed") || cmd.includes("41"), "健康门禁要能表达 rollback_failed");
});

test("upgraderCommand：容器名走参数（用例可断言，生产用默认值）", () => {
    const info = readComposeInfo(LABELS(), "");
    assert.ok(info);
    const cmd = upgraderCommand(info, "my-navihive");
    assert.ok(cmd.includes("my-navihive"), "容器名要能被替换");
    assert.ok(!cmd.includes("docker inspect --format='{{.Image}}' navihive "), "不该残留默认名");
});

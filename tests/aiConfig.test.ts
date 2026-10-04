// tests/aiConfig.test.ts
// AI 助手配置的解析与「还缺什么」的判定。
//
// 这个文件顶部那句注释点明了它为什么必须有测试：
//   「前端拿它决定按钮置不置灰，Worker 拿它决定要不要发请求，两边说不到一块去的
//     话就会出现『界面上能点、一点就报 500』。」
// 也就是说 aiConfigProblem 的返回值是**前后端的契约**：返回 null 就一定要能发请求，
// 返回非 null 就一定要能在界面上置灰。它一旦漂移，用户看到的就是「点了没反应」或者
// 「500」，而两边各自看代码都觉得没问题。
//
// 另一件要钉住的事：enabled 只认显式 "true"，其它一律当关着。这是刻意的安全设计 ——
// 配错了、读失败了都绝不能默认把站点数据往外发。所以「大小写不敏感一点更贴心」这种
// 改动在这里是**倒退**，测试要能挡住。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AI_PROVIDERS,
    aiConfigProblem,
    aiSettingsFromConfigs,
    OPENAI_EMBED_MODEL,
    OPENAI_TEXT_MODEL,
    WORKERS_EMBED_MODEL,
    WORKERS_TEXT_MODEL,
    type AiSettings,
} from "../src/utils/aiConfig";

const base: AiSettings = {
    enabled: true,
    provider: "workers-ai",
    endpoint: "",
    textModel: "",
    embedModel: "",
    apiKey: "",
    cfToken: "",
    cfAccount: "",
};

const withFields = (over: Partial<AiSettings>): AiSettings => ({ ...base, ...over });

// ---------- 解析 ----------

test("开关只认显式 true：其它值一律当关着", () => {
    for (const v of ["TRUE", "True", "1", "yes", "on", ""]) {
        assert.equal(
            aiSettingsFromConfigs({ "ai.enabled": v }).enabled,
            false,
            `「${v}」不该被当成开启 —— 配错时宁可关着，也不能默认把数据往外发`
        );
    }
    assert.equal(aiSettingsFromConfigs({ "ai.enabled": "true" }).enabled, true);
    // 前后空格要先 trim：粘贴配置时很容易带进来，而这里 trim 掉并不会放宽「只认 true」
    assert.equal(aiSettingsFromConfigs({ "ai.enabled": " true " }).enabled, true);
});

test("没配过任何东西时，AI 是关着的", () => {
    assert.equal(aiSettingsFromConfigs({}).enabled, false);
});

test("provider 只认 openai-compatible，其它一律回落到 workers-ai", () => {
    assert.equal(aiSettingsFromConfigs({}).provider, "workers-ai");
    assert.equal(aiSettingsFromConfigs({ "ai.provider": "" }).provider, "workers-ai");
    // 大小写不同也不认：认了就等于把「填了但填错」静默当成另一种 provider
    assert.equal(
        aiSettingsFromConfigs({ "ai.provider": "OpenAI-Compatible" }).provider,
        "workers-ai"
    );
    assert.equal(aiSettingsFromConfigs({ "ai.provider": "gpt" }).provider, "workers-ai");
    assert.equal(
        aiSettingsFromConfigs({ "ai.provider": "openai-compatible" }).provider,
        "openai-compatible"
    );
});

test("模型没填时按 provider 给默认值，省得用户去查模型名", () => {
    assert.equal(
        aiSettingsFromConfigs({}).textModel,
        WORKERS_TEXT_MODEL,
        "workers-ai 的默认模型"
    );
    assert.equal(aiSettingsFromConfigs({}).embedModel, WORKERS_EMBED_MODEL);

    const openai = aiSettingsFromConfigs({ "ai.provider": "openai-compatible" });
    assert.equal(openai.textModel, OPENAI_TEXT_MODEL);
    assert.equal(openai.embedModel, OPENAI_EMBED_MODEL);
});

test("用户填了模型就用他的，不被默认值覆盖", () => {
    const s = aiSettingsFromConfigs({
        "ai.textModel": "gpt-4o-mini",
        "ai.embedModel": "text-embedding-3-large",
    });
    assert.equal(s.textModel, "gpt-4o-mini");
    assert.equal(s.embedModel, "text-embedding-3-large");
});

test("读出来的值都 trim 过：粘贴时带空格不该让配置失效", () => {
    const s = aiSettingsFromConfigs({
        "ai.provider": "  openai-compatible  ",
        "ai.endpoint": "  https://api.deepseek.com  ",
        "ai.apiKey": "  sk-xxx  ",
    });
    assert.equal(s.provider, "openai-compatible");
    assert.equal(s.endpoint, "https://api.deepseek.com");
    assert.equal(s.apiKey, "sk-xxx");
});

test("配置里缺字段（undefined）不会炸", () => {
    const s = aiSettingsFromConfigs({ "ai.enabled": "true" });
    assert.equal(s.endpoint, "");
    assert.equal(s.apiKey, "");
    assert.equal(s.cfToken, "");
    assert.equal(s.cfAccount, "");
});

test("两个 provider 的元数据对得上（设置界面靠它渲染下拉）", () => {
    assert.deepEqual(
        AI_PROVIDERS.map(p => p.value),
        ["workers-ai", "openai-compatible"]
    );
    for (const p of AI_PROVIDERS) {
        assert.ok(p.label, `${p.value} 要有显示名`);
        assert.ok(p.hint, `${p.value} 要有说明`);
    }
});

// ---------- 「还缺什么」的判定 ----------

test("没开就先说没开", () => {
    assert.match(aiConfigProblem(withFields({ enabled: false })) ?? "", /没开/);
});

test("workers-ai：先说缺 token，再说缺账号 ID", () => {
    assert.match(aiConfigProblem(base) ?? "", /token/);
    assert.match(aiConfigProblem(withFields({ cfToken: "t" })) ?? "", /账号 ID/);
    assert.equal(aiConfigProblem(withFields({ cfToken: "t", cfAccount: "a" })), null);
});

test("workers-ai 不需要端点与 API 密钥（走 Cloudflare 自己的接口）", () => {
    // 反过来要求会逼用户填一堆用不上的东西
    assert.equal(aiConfigProblem(withFields({ cfToken: "t", cfAccount: "a" })), null);
});

test("openai-compatible：先端点、再协议、再密钥", () => {
    const p = withFields({ provider: "openai-compatible" });
    assert.match(aiConfigProblem(p) ?? "", /接口地址/);
    assert.match(
        aiConfigProblem(withFields({ ...p, endpoint: "api.deepseek.com" })) ?? "",
        /http/,
        "没写协议的端点要被挡下来，而不是拼出个奇怪的 URL"
    );
    assert.match(
        aiConfigProblem(withFields({ ...p, endpoint: "https://api.deepseek.com" })) ?? "",
        /密钥/
    );
    assert.equal(
        aiConfigProblem(
            withFields({ ...p, endpoint: "https://api.deepseek.com", apiKey: "sk-x" })
        ),
        null
    );
});

test("端点不接受 javascript: 之类的协议", () => {
    const p = withFields({
        provider: "openai-compatible",
        apiKey: "sk-x",
    });
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/plain,x"]) {
        assert.ok(
            aiConfigProblem({ ...p, endpoint: bad }),
            `「${bad}」必须被挡住：这条规则是前端与 Worker 共用的最后一道`
        );
    }
});

test("端点协议大小写不敏感（HTTPS:// 也是合法的）", () => {
    const p = withFields({
        provider: "openai-compatible",
        apiKey: "sk-x",
        endpoint: "HTTPS://api.deepseek.com",
    });
    assert.equal(aiConfigProblem(p), null);
});

test("前后端共用同一份判定：返回 null 就是「可以发请求」的全部条件", () => {
    // worker/ai.ts 与 worker/routes/ai.ts 都调 aiConfigProblem 决定要不要发请求，
    // 前端拿同一个返回值决定按钮置不置灰 —— 这里把两条完整配置都走一遍，
    // 确保「完整」这件事两边说的是同一件事。
    const workersComplete = withFields({ cfToken: "t", cfAccount: "a" });
    const openaiComplete = withFields({
        provider: "openai-compatible",
        endpoint: "https://api.deepseek.com",
        apiKey: "sk-x",
    });
    assert.equal(aiConfigProblem(workersComplete), null);
    assert.equal(aiConfigProblem(openaiComplete), null);

    // 少任何一项都不行
    assert.ok(aiConfigProblem({ ...workersComplete, cfToken: "" }));
    assert.ok(aiConfigProblem({ ...openaiComplete, apiKey: "" }));
});

#!/usr/bin/env node
// scripts/rotate-secrets.mjs
// 密钥轮换助手：只**生成**新密钥并打印 wrangler 命令，不替你执行。
//
// 为什么要轮换：仓库是公开的，而它经历过一次历史重写（SHA 分叉修复时把提交重放到
// 真实远端 head 上）。重写之后**当前**历史里已经没有明文密钥了（用 git log -G
// 'AUTH_PASSWORD=实际值' 查过，两个命中提交的 AUTH_PASSWORD 都是空占位或运行时
// 随机生成）—— 但 GitHub 对被丢弃的提交对象并不保证立刻回收，知道 SHA 的人仍可能
// 取到旧内容。所以轮换是稳妥选择，不是因为确认泄漏。
//
// ⚠️ 轮换的代价，务必先读：
//   - AUTH_SECRET / DATA_ENCRYPTION_KEY 是**库里已加密数据**的解密钥匙
//     （站点密码、WebDAV 口令、AI 密钥）。换了之后旧密文解不开 ——
//     不是「数据没了」，是「那些字段变成读不出的乱码」。
//   - 所以顺序必须是：先导出一份备份（此时还能解密）→ 再轮换 → 再把那些加密项重填一遍。
//
// 用法：node scripts/rotate-secrets.mjs
//       node scripts/rotate-secrets.mjs --json     # 机器可读（自己接 wrangler）
// 需要先 npm run deploy 之前的构建产物？不需要 —— 这个脚本不碰 dist。

import crypto from "node:crypto";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

/** 32 字节随机密钥（hex，64 字符）—— 与 worker 里 deriveKey 的预期长度一致 */
function newSecret() {
    return crypto.randomBytes(32).toString("hex");
}

/** 恢复密钥对：Ed25519（密钥短、签名快），私钥走 PKCS8、公钥走 SPKI */
async function newRecoveryKeyPair() {
    const kp = crypto.generateKeyPairSync("ed25519");
    const publicKey = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKey = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    return { publicKey, privateKey };
}

const authSecret = newSecret();
const dataEncryptionKey = newSecret();
const recovery = await newRecoveryKeyPair();

// 公钥要塞进 AUTH_RECOVERY_PUBLIC_KEY：worker 用它验签恢复令牌。
// 单行 base64（不带换行与 PEM 头）才方便当环境变量/secret 存。
const publicKeyB64 = Buffer.from(recovery.publicKey, "utf8").toString("base64");

if (asJson) {
    console.log(
        JSON.stringify(
            { AUTH_SECRET: authSecret, DATA_ENCRYPTION_KEY: dataEncryptionKey, AUTH_RECOVERY_PUBLIC_KEY: publicKeyB64, RECOVERY_PRIVATE_KEY_PEM: recovery.privateKey },
            null,
            2
        )
    );
    process.exit(0);
}

const line = "=".repeat(72);
console.log(line);
console.log("密钥轮换助手 —— 只生成，不执行。命令要你自己复制去跑。");
console.log(line);

console.log(`
⚠️ 先做这件事，否则换了钥匙之后库里的加密字段就读不出来了：

  1. 登录站点 → 数据备份 → 导出一份到本地（此时旧钥匙还在，能正常解密）
  2. 记住 WebDAV 的网盘口令 / AI 密钥 —— 轮换后要重新填一次
  3. 再往下执行 wrangler secret put
`);

console.log("---- 1) 会话签名与加密的钥匙 ----\n");
console.log(`npx wrangler secret put AUTH_SECRET <<< '${authSecret}'`);
console.log(`npx wrangler secret put DATA_ENCRYPTION_KEY <<< '${dataEncryptionKey}'`);

console.log("\n---- 2) 恢复密钥对（忘了密码时的后门）----\n");
console.log(`# 公钥：服务器只持公钥验签，没有私钥造不出合法恢复令牌`);
console.log(`npx wrangler secret put AUTH_RECOVERY_PUBLIC_KEY <<< '${publicKeyB64}'`);
console.log("\n# 私钥：**只保存在你自己手里**（密码管理器 / 离线介质），不要提交、不要贴进仓库");
console.log(recovery.privateKey);

console.log("\n---- 3) 管理员密码 ----\n");
console.log("npx wrangler secret put AUTH_PASSWORD");
console.log("# 或者用现成的脚本重置：node scripts/reset-admin-password.mjs");

console.log(`
---- 轮换之后 ----

  - 用旧钥匙加密的站点密码 / WebDAV 口令会变成解不开的乱码，
    到「数据备份」里把 WebDAV 口令重新填一次即可（新写入用新钥匙）。
  - 恢复私钥请立刻离线保存：它丢了 = 以后忘记密码就再也进不来。
  - 轮换完跑一次 npm run e2e 确认后端契约还通。

${line}
`);

// server/upgradeAudit.ts
// 「网页直接升级」（POST /api/system/upgrade）的**审计判定**——从 server/entry.ts 抽出来的纯逻辑。
//
// 为什么单独一个文件：那个端点写在 server/entry.ts 里，而 entry.ts 是「一 import 就
// 拉起 HTTP 服务」的进程入口（顶层 await + createServer + 读 .env），单测没法引入它
// （它也因此被 script/coverage.mjs 显式排除）。把「什么情况该落审计、落成什么样」抽成
// 纯函数后，这一段就能被用例逐格钉住；entry.ts 只负责把结论交给 writeAudit。
// 同一套路见 server/net.ts / server/static.ts / server/slowQuery.ts。
//
// 背景（2026-10-28 真实事故，不是假设）：v17.0.0 发布后 navihive-upgrader 在 13:58:36
// 拉镜像、重建容器成功、healthy —— 但 audit_log 里**一条记录都没有**，事后说不清
// 「谁、在什么时间、从哪个 IP 把生产容器换掉的」。这个端点原来有两道闸
// （role === "owner" + spoolEnabled()/dockerAvailable()），全程没有一次 writeAudit：
// 闸门只管「准不准」，不管「留没留痕」。审计在这里不为追责，是为「上线结果可追溯」——
// 和批次一修的「镜像门禁不看 CI 结论」是同一条主线。

/** 升级是怎么被触发的：交给宿主上的升级器，还是由本进程直接打 Docker Engine API */
export type UpgradeTrigger = "spool" | "docker-api";

/**
 * 升级请求的结论。**每一种结论都要显式列出来**（含「不落审计」的那两种），
 * 这样「为什么这次没有记录」是一个写在代码里的决定，而不是一段被忘掉的 if。
 */
export type UpgradeOutcome =
    /** 闸门全过，升级已受理（真正开始动手） */
    | { kind: "accepted"; trigger: UpgradeTrigger; image: string }
    /** 闸门全过，但把请求交给升级器这一步就失败了（spool 目录写不进去等） */
    | { kind: "submit-failed"; image: string; message: string }
    /** 已登录、但不是 owner —— 越权尝试 */
    | { kind: "denied"; username: string; role: string }
    /** 连身份都拿不到（没带凭证 / 令牌过期 / 扫描器盲打） */
    | { kind: "anonymous" }
    /** 是 owner，但这个部署形态不支持网页升级（没 spool 目录、也没挂 docker.sock） */
    | { kind: "unsupported"; image: string };

/** 落库时的四个字段（与 NavigationAPI.writeAudit 的签名一一对应） */
export interface UpgradeAuditEntry {
    /** 审计动作名，展示前会经 src/utils/auditActionLabels.ts 翻成中文 */
    action: string;
    /** 谁做的 */
    actor: string;
    /** 做什么 —— 单行，已截断（见 compact） */
    detail: string;
}

/** 受理并真正开始升级。前端「审计流水」里显示为「网页触发升级」 */
export const UPGRADE_ACTION = "system-upgrade";
/** 点了升级但连请求都没提交出去 —— 必须有记录，否则「点了没反应」查不到任何痕迹 */
export const UPGRADE_FAILED_ACTION = "system-upgrade.failed";
/** 已登录的非 owner 尝试升级（越权） */
export const UPGRADE_DENIED_ACTION = "system-upgrade.denied";

/**
 * detail 的长度上限。
 *
 * 进审计表的 detail 是给人在对话框里读的一句话，不是日志：spool 的报错里可能带
 * 完整的文件路径与 errno 说明，原样塞进去会把审计流水撑成一堵墙。
 * 200 字符足够说明「卡在哪一步」，排查细节去 console 日志（那里不截断、还有 rid）。
 */
const DETAIL_MAX = 200;

/** 压成单行并截断：detail 是一句话，换行与超长都只让人更难读 */
function compact(text: string): string {
    const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
    return oneLine.length > DETAIL_MAX ? `${oneLine.slice(0, DETAIL_MAX)}…` : oneLine;
}

/** 触发方式的中文说明：「谁执行了这次升级」是这条审计的一半价值 */
function triggerLabel(trigger: UpgradeTrigger): string {
    return trigger === "spool" ? "spool（宿主升级器）" : "docker-api（unix socket）";
}

/**
 * 判定这次升级请求该不该落审计、落成什么样。
 *
 * 返回 null = **结论是「不记」**，entry.ts 拿到 null 就什么都不做。
 * 两条「不记」的理由都写在下面 —— 它们是判断，不是遗漏：
 *
 * ① `anonymous`（401/403 但拿不到身份）：**不记**。
 *    这道闸在鉴权之后，一次盲扫就能让 /api/system/upgrade 回一屏 403；而它对应的
 *    是「零变更」——没有容器被换掉、没有配置被改。审计表是给「谁改了什么」用的，
 *    把噪声写进去只会把真正的变更挤到看不见的地方。真正该关心的「有人一直在试密码」
 *    已经在 worker/routes/public.ts 的 login.failed 那条链上节流记录着。
 *
 * ② `unsupported`（501）：**不记**。
 *    它是**部署形态的静态事实**（这个容器没配 NAVIHIVE_UPGRADE_SPOOL、宿主机也没把
 *    docker.sock 挂进来），不是一次变更：没有任何东西被改，明天再点还是同一条。
 *    而且这个事实 GET /api/system/upgrade 的 `supported` 字段随时能问到，
 *    前端拿到 501 也会回落到「复制命令去后台」。为一个不含信息量的常量单开一个动作名，
 *    只会让动作表变长、让审计流水看起来「升级天天在失败」。
 *
 * 反过来，`denied` 是**记**的：它同样零变更，但它是一次真实的越权尝试 ——
 * 能走到这里说明对方已经持有本实例的有效登录态，这是安全事故的第一手材料。
 * （单实例部署里 owner 通常只有一个人，量也不会大。）
 */
export function decideUpgradeAudit(outcome: UpgradeOutcome): UpgradeAuditEntry | null {
    switch (outcome.kind) {
        case "accepted":
            return {
                action: UPGRADE_ACTION,
                // actor 用 "owner" 而不是账号名：能过闸的只有 owner 这一个角色，
                // 写角色比写名字更稳（账号改名 / 将来支持多 owner 都不用回改历史记录）。
                actor: "owner",
                detail: compact(`镜像 ${outcome.image}，触发方式：${triggerLabel(outcome.trigger)}`),
            };
        case "submit-failed":
            return {
                action: UPGRADE_FAILED_ACTION,
                actor: "owner",
                detail: compact(`镜像 ${outcome.image}，提交升级请求失败：${outcome.message}`),
            };
        case "denied":
            return {
                action: UPGRADE_DENIED_ACTION,
                actor: outcome.username || "unknown",
                detail: compact(`非 owner 尝试触发升级（角色：${outcome.role || "unknown"}）`),
            };
        case "anonymous":
            return null;
        case "unsupported":
            return null;
        default: {
            // 穷尽性检查：将来给 UpgradeOutcome 加新结论时这里会编译报错，
            // 而不是静默地「什么都不记」。
            const exhaustive: never = outcome;
            return exhaustive;
        }
    }
}

/** 落库动作：由 entry.ts 注入（它才拿得到 NavigationAPI 与请求 IP） */
export type AuditWriter = (action: string, actor: string, ip: string, detail: string) => Promise<void>;

/**
 * 判定 + 落库。返回**是否真的写了一条**（用例靠它断言「这里不该写」）。
 *
 * ⚠️ 这里吞掉所有异常。这个 API 的既有契约是「先响应再升级」——本进程随时会被
 * 升级流程杀掉，审计写失败绝不允许反过来把「升级已提交」这个响应搞挂。
 * （NavigationAPI.writeAudit 内部自己已经 try/catch 过一轮，这里再兜一层是因为
 * 构造 NavigationAPI、取 DB 绑定这些步骤也在被兜的范围内 —— 见 worker/index.ts
 * 的 recordServerError，同一个理由。）
 */
export async function recordUpgradeAudit(
    outcome: UpgradeOutcome,
    ip: string,
    write: AuditWriter
): Promise<boolean> {
    const entry = decideUpgradeAudit(outcome);
    if (!entry) return false;
    try {
        await write(entry.action, entry.actor, ip || "", entry.detail);
        return true;
    } catch (error) {
        console.warn(
            "[upgrade] 审计落库失败（不影响升级）:",
            error instanceof Error ? error.message : String(error)
        );
        return false;
    }
}

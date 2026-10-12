// src/utils/cronErrorDismiss.ts
// 「每周自动备份失败」这类 cron 失败提示的**忽略一周**。
//
// 为什么要有：cron 失败留痕（cron.lastError.<task>）在前端每次启动都会弹一次，
// 直到下一个 cron 窗口跑成功才会被清掉 —— 备份是一周一次，用户就得被同一条
// 消息骚扰一周。给他一个「知道了，这周别再弹」的出口。
//
// 存 localStorage 而不是服务端：这是个「别烦我」的本地偏好，不是跨设备
// 必须一致的数据；而且写服务端就得动 system config 的写入口，为一个
// 提示的消音不值得。⚠️ localStorage 一访问就抛的环境（隐私模式/禁站点数据）
// 必须兜住 —— 抛在渲染期就是整页白屏，见 useThemeController 的教训。

const DISMISS_KEY = "cron.lastError.dismissed";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface DismissRecord {
    message: string;
    until: number;
}

/** 这条消息是否在忽略期内（message 相同且没过期才算） */
export function cronErrorDismissed(message: string, now = Date.now()): boolean {
    try {
        const raw = globalThis.localStorage?.getItem(DISMISS_KEY);
        if (!raw) return false;
        // 坏 JSON / 缺字段一律当「没忽略过」—— 兜底不能把正常提示吞掉
        const rec = JSON.parse(raw) as Partial<DismissRecord>;
        if (typeof rec.message !== "string" || typeof rec.until !== "number") return false;
        if (rec.message !== message) return false;
        return now < rec.until;
    } catch {
        return false;
    }
}

/** 忽略这条消息一周 */
export function dismissCronError(message: string, now = Date.now()): void {
    try {
        const rec: DismissRecord = { message, until: now + WEEK_MS };
        globalThis.localStorage?.setItem(DISMISS_KEY, JSON.stringify(rec));
    } catch {
        /* 隐私模式下写不了，忽略 —— 最坏结果是下次还弹，无害 */
    }
}

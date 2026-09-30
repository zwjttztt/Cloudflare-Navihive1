// src/utils/siteForm.ts
// 「新建卡片」表单里的两处纯计算，从 App.tsx 搬出来：
// 表单字段变更怎么落到状态上（含图标自动跟随 URL）、新卡片的默认排序值取多少。
// 都是「改坏了不报错、但用户会难受」的那类，抽成纯函数才好钉住（用例 tests/siteForm.test.ts）。
import type { Site } from "../API/http";
import { resolveIconApiUrl } from "./iconApi";
import { formDataKey } from "./secretInput";

/** 新建卡片表单的初始状态（每次打开弹窗都重置成它） */
export function emptySiteDraft(): Partial<Site> {
    return {
        name: "",
        url: "",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: "",
        order_num: 0,
        group_id: 0,
    };
}

/**
 * 把一次输入事件落到新建卡片的表单状态上。
 *
 * 两件容易写错的事：
 * - 输入框的 name 为了躲开浏览器的登录表单识别，叫 site-account / site-secret，
 *   状态里的键仍是 username / password（见 utils/secretInput.ts）；
 * - 改「站点URL」时要按图标 API 自动生成图标，**但只能覆盖自动生成的那个值** ——
 *   用户手填过的图标不能被冲掉，不然每改一次网址手填的图标就没了。
 */
export function applySiteInputChange(
    prev: Partial<Site>,
    iconApi: string,
    name: string,
    value: string
): Partial<Site> {
    // name 是 input 的原始 name（不是状态键），图标那一步只看原始 name
    const key = formDataKey(name);
    const next: Partial<Site> = { ...prev, [key]: value };

    if (name === "url") {
        const autoIcon = resolveIconApiUrl(iconApi, value);
        const prevAutoIcon = resolveIconApiUrl(iconApi, prev.url || "");
        if (!prev.icon || prev.icon === prevAutoIcon) {
            next.icon = autoIcon;
        }
    }

    return next;
}

/** 新卡片插在分组末尾：现有最大 order_num + 1，空分组从 0 开始 */
export function nextSiteOrderNum(group: { sites: { order_num: number }[] } | undefined): number {
    const sites = group?.sites ?? [];
    if (sites.length === 0) return 0;
    return Math.max(...sites.map(s => s.order_num ?? 0)) + 1;
}

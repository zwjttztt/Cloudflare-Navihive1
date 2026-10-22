// src/utils/deviceId.ts
// 稳定的「这台设备」标识（2026-10-22，修「每次开机第一次就要重新登录」）。
//
// 为什么要它：
//   服务端原本用 **归一化 UA**（浏览器 + 系统，不计版本与 IP）判断「是不是同一台设备」，
//   同设备的旧会话会被拉黑删除（2026-10-17 修「登录设备重复显示」时做的）。
//   问题是这台电脑只要有第二个「Windows + Chrome」客户端 —— 另一台电脑、另一个
//   Chrome 配置文件、甚至 Parallels 里的虚拟机 —— 归一化后就拿到**同一把键**：
//   后登录的把先登录的令牌拉黑，先登录的那台下次一打开就 401，于是又要登录；
//   再登录又把对方踢掉 → 两台机器互相顶下线，表现为「每次开机第一次都要登录」。
//   （2026-10-22 在线上审计流水里抓到实证：登录成功前必有 401，且出现过
//    登录→57 秒后 401→再登录→26 秒后 401 的循环。）
//
// 所以：设备身份必须由**客户端自己给一个稳定 ID**，UA 只用来在界面上描述设备。
//
// ⚠️ 隐私模式 / 禁用 localStorage：返回 null。服务端拿到 null 会回退到 UA 归一化
//    （老行为）—— 那种场景下宁可重复也不误踢。
// ⚠️ 安全边界：这个 ID **不是凭证**。它唯一的作用是「别把别人的设备误判成自己」。
//    伪造它最多让自己的会话在列表里合并显示，不带来任何越权。
import { useEffect, useState } from "react";

const DEVICE_ID_KEY = "navihive_device_id";

/** 读不到就地生成一个（crypto.randomUUID 在 http 下也有；再不行用时间戳+随机） */
function createId(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 取本机设备 ID（没有就地创建并持久化）。
 *
 * ⚠️ 必须在**浏览器**里调用：服务端渲染 / node 环境下没有 localStorage，
 *    直接返回 null（服务端本来也不需要它，只有登录请求体里带）。
 */
export function getDeviceId(): string | null {
    try {
        const store = globalThis.localStorage;
        if (!store) return null;
        const existing = store.getItem(DEVICE_ID_KEY);
        if (existing) return existing;
        const id = createId();
        store.setItem(DEVICE_ID_KEY, id);
        return id;
    } catch {
        // 隐私模式：读写都抛
        return null;
    }
}

/** 登录 / 注册请求体里带的设备标识（没有就 null，服务端会回退 UA） */
export function deviceIdField(): { deviceId?: string } {
    const id = getDeviceId();
    return id ? { deviceId: id } : {};
}

/**
 * hook 版：给登录表单在挂载时就能拿到（不阻塞渲染，拿不到就是 null）。
 * 之所以用 state 而不是直接调函数：登录提交时再拿也来得及，但提前拿一次可以让
 * 「隐私模式下设备 ID 恒为 null」这件事在开发时一眼看出来。
 */
export function useDeviceId(): string | null {
    const [id, setId] = useState<string | null>(null);
    useEffect(() => {
        setId(getDeviceId());
    }, []);
    return id;
}

// src/utils/siteAvatar.ts
// 图标取不到时，按站点名哈希出一个稳定的配色，避免所有占位块长得一模一样。
// 从 SiteCard 抽出（#86）：纯函数，可独立测试「同名同色、异名散列」。

export interface AvatarTone {
    strong: string;
    soft: string;
}

export const AVATAR_TONES: AvatarTone[] = [
    { strong: "#1565C0", soft: "#90CAF9" },
    { strong: "#6A1B9A", soft: "#CE93D8" },
    { strong: "#00695C", soft: "#80CBC4" },
    { strong: "#C62828", soft: "#EF9A9A" },
    { strong: "#EF6C00", soft: "#FFCC80" },
    { strong: "#2E7D32", soft: "#A5D6A7" },
    { strong: "#4527A0", soft: "#B39DDB" },
    { strong: "#00838F", soft: "#80DEEA" },
];

export function toneForName(name: string): AvatarTone {
    const str = name || "?";
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}

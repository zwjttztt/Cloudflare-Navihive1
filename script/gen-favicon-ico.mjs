// script/gen-favicon-ico.mjs
// 从 public/favicon.svg（指南针蜂巢）重建 public/favicon.ico。用法：npm run icons:ico
// 换了 logo 就要跑一次 —— 这个文件是「SVG 不支持时」的兜底，最容易漏。
//
// 为什么要多尺寸：Windows 快捷方式、老浏览器、部分 RSS 阅读器会直接读 .ico，
// 它们按自己的场景挑 16 / 32 / 48。2026-09-26 那版旧图（蓝圆 + 双层六边形）
// 一直躺在仓库里，16.3.0 换 logo 时没跟上，于是「logo 没变」的观感一半来自它。
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const SIZES = [16, 24, 32, 48, 64];
const svg = readFileSync("public/favicon.svg");

/**
 * 16/24 专用的简化版：**去掉六边形描边**，只留一支加粗的白指针。
 *
 * 为什么必须分档：完整图形在 96 的 viewBox 里描边 6、指针宽 9，缩到 16px
 * 之后是 1px / 1.5px 的浅蓝灰线，实测（script/_ico_16_candidates.png 那次对比）
 * 糊成一个方框，认不出是什么。小尺寸该做减法，不是硬缩。
 * 32px 起仍用原图 —— 那时六边形已经能看出来了。
 */
const SMALL_SVG = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
        <rect width="96" height="96" rx="22" fill="#1976d2"/>
        <polygon points="48,12 68,52 30,52" fill="#ffffff"/>
        <polygon points="48,84 68,56 30,56" fill="#ffffff" fill-opacity="0.45"/>
    </svg>`
);

const pngs = [];
for (const size of SIZES) {
    // density 1152 → 96 * 1152/72 = 1536px 的中间栅格，再缩到目标尺寸：
    // 直接以 16px 渲染会让细描边糊掉，先大后小才有干净的抗锯齿。
    const buf = await sharp(size <= 24 ? SMALL_SVG : svg, { density: 1152 })
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
    pngs.push({ size, buf });
}

// ICO 容器：6 字节头 + 每张 16 字节目录项 + PNG 数据（Vista 起允许 PNG 负载）
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(count, 4);

const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
pngs.forEach((p, i) => {
    const e = i * 16;
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 0); // width（256 写 0）
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1); // height
    entries.writeUInt8(0, e + 2); // 调色板颜色数（真彩 = 0）
    entries.writeUInt8(0, e + 3); // 保留位
    entries.writeUInt16LE(1, e + 4); // 色彩平面
    entries.writeUInt16LE(32, e + 6); // 位深 RGBA
    entries.writeUInt32LE(p.buf.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += p.buf.length;
});

const ico = Buffer.concat([header, entries, ...pngs.map(p => p.buf)]);
writeFileSync("public/favicon.ico", ico);
console.log(`✓ public/favicon.ico 已重建（${SIZES.join("/")} px，共 ${ico.length} 字节）`);

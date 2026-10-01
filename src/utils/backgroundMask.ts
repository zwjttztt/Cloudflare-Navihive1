// src/utils/backgroundMask.ts
// 自定义背景的蒙版换算：滑块值越大 → 图片越清晰 → 蒙版越淡。
//
// 但「完全不要蒙版」是不允许的：用户挑的图亮度不可控，亮图上压浅色文字、
// 暗图上压深色文字都可能读不清，而网站没法替每个人验一遍对比度。
// 所以这里留一层下限 —— 滑块拉到最右也仍有 MIN_BACKGROUND_MASK 的蒙版，
// 代价是图片稍微没那么透亮，换来的是文字在任何图上都不会糊掉。

/** 蒙版不透明度的下限（0~1，越大压得越暗） */
export const MIN_BACKGROUND_MASK = 0.12;

/**
 * 把设置里的滑块值（0~1，越大越清晰）换算成蒙版不透明度。
 * 非法输入（NaN / 越界）一律当成「最清晰」，也就是取下限，不会把图盖死。
 */
export function backgroundMaskOpacity(sliderValue: number): number {
    const safe = Number.isFinite(sliderValue)
        ? Math.min(1, Math.max(0, sliderValue))
        : 1;
    return Math.max(MIN_BACKGROUND_MASK, 1 - safe);
}

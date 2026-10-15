// src/components/AriaLiveRegion.tsx
// 读屏播报区：视觉上不可见，但每次提示都会同步到这里（aria-live）。
//
// 为什么从 SnackbarHost 拆出来还**保持常驻**：aria-live 区域必须先于内容存在，
// 读屏软件才会把「内容变化」念出来 —— 区域和内容一起出现，多数读屏不出声。
// 而 SnackbarHost 为了首屏字节改成了懒加载 + 有提示才挂载（2026-10-15 审计 P1：
// MUI 的 Snackbar 那套不该进首屏关键路径，见 docs/site-audit-2026-10-15.md），
// 所以播报区必须独立成一个常驻组件。
//
// 刻意不 import 任何 MUI：一个带 inline style 的 div 就够，零依赖才能安全地
// 留在首屏图里（不会把任何东西拽进关键路径）。
export default function AriaLiveRegion({ message }: { message: string }) {
    return (
        <div
            role='status'
            aria-live='polite'
            aria-atomic='true'
            style={{
                position: "absolute",
                width: 1,
                height: 1,
                margin: -1,
                padding: 0,
                border: 0,
                overflow: "hidden",
                whiteSpace: "nowrap",
                clip: "rect(0 0 0 0)",
            }}
        >
            {message}
        </div>
    );
}

// src/hooks/useScrollLock.ts
// 全屏组件（记事本这类盖住整屏的「页面」）挂载期间锁住整页滚动。
//
// 为什么要单独抽一个 hook 而不是在组件里直接写 body.style：
// 记事本是 `position: fixed` 的全屏层，**它自己不会把页面撑高**，
// 但底下的主界面还留在文档流里（卡片网格一两千像素），照样能让 document
// 出现滚动条 —— 于是「记事本里」也能拖滚动条，看着像页面坏了。
// 光把记事本那层做成 fixed + overflow:hidden 是不够的，必须按住 document。
//
// 两个坑：
//  1. 直接 `overflow: hidden` 会让滚动条消失、视口变宽，底下的内容横向抖一下
//     （FUCH）。要补上等宽的 padding-right 抵消掉这一段。
//  2. 一定要**存下并还原**原来的内联值，不能无脑写 ""。App 里别处也可能
//     改过 body 的内联样式，清零会把它一起抹掉。
import { useEffect } from "react";

export function useScrollLock(active: boolean): void {
    useEffect(() => {
        if (!active || typeof document === "undefined") return;

        const body = document.body;
        const root = document.documentElement;
        const prev = {
            bodyOverflow: body.style.overflow,
            bodyPaddingRight: body.style.paddingRight,
            rootOverflow: root.style.overflow,
        };

        const barWidth = window.innerWidth - root.clientWidth;
        body.style.overflow = "hidden";
        root.style.overflow = "hidden";
        if (barWidth > 0) body.style.paddingRight = `${barWidth}px`;

        return () => {
            body.style.overflow = prev.bodyOverflow;
            body.style.paddingRight = prev.bodyPaddingRight;
            root.style.overflow = prev.rootOverflow;
        };
    }, [active]);
}

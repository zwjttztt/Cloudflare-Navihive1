// src/hooks/useAppDialogs.ts
// App 级弹窗的开关状态集中营：命令面板 / 访问统计 / 快捷键说明 /
// 书签导入 / 标签管理 / 重复网址确认。
// 只管「哪个弹窗开着」；弹窗内部的数据与提交逻辑仍在 App 与各弹窗组件里。

import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DuplicateHit } from "../utils/duplicate";

/** 重复网址确认：撞车时先问一句，run 是用户确认后真正要执行的动作 */
export interface DupPrompt {
    url: string;
    hit: DuplicateHit;
    run: () => void | Promise<void>;
}

export interface AppDialogsState {
    /** 命令面板（Ctrl / Cmd + K） */
    commandOpen: boolean;
    /** 访问统计弹窗（热力图 + Top5） */
    openVisits: boolean;
    /** 快捷键说明表（按 ? 打开） */
    openShortcuts: boolean;
    /** 浏览器书签导入 */
    bookmarkOpen: boolean;
    /** 「标签管理」弹窗 */
    tagManagerOpen: boolean;
    /** 重复网址确认弹窗的内容（null = 关闭） */
    dupPrompt: DupPrompt | null;
    setCommandOpen: (value: boolean) => void;
    setOpenVisits: (value: boolean) => void;
    setOpenShortcuts: (value: boolean) => void;
    setBookmarkOpen: (value: boolean) => void;
    setTagManagerOpen: (value: boolean) => void;
    setDupPrompt: Dispatch<SetStateAction<DupPrompt | null>>;
}

export function useAppDialogs(): AppDialogsState {
    const [commandOpen, setCommandOpen] = useState(false);
    const [openVisits, setOpenVisits] = useState(false);
    const [openShortcuts, setOpenShortcuts] = useState(false);
    const [bookmarkOpen, setBookmarkOpen] = useState(false);
    const [tagManagerOpen, setTagManagerOpen] = useState(false);
    const [dupPrompt, setDupPrompt] = useState<DupPrompt | null>(null);

    return {
        commandOpen,
        openVisits,
        openShortcuts,
        bookmarkOpen,
        tagManagerOpen,
        dupPrompt,
        setCommandOpen,
        setOpenVisits,
        setOpenShortcuts,
        setBookmarkOpen,
        setTagManagerOpen,
        setDupPrompt,
    };
}

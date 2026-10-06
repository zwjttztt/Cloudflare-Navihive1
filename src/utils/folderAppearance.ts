// src/utils/folderAppearance.ts
// 文件夹外观（icon / color）的**约定枚举**与渲染辅助。
//
// 为什么是枚举而不是自由文本：左栏 128px 宽，颜色只用于一枚小图标 ——
// 自由调色盘换来的自由度远小于「脏数据把左栏画崩」的风险。
// 调色板与 inkstone 设置页里那排强调色圆点同一组色相。
//
// 图标清单放在 utils（而不是组件文件）：左栏渲染与外观弹窗两处都要用，
// 而且放组件文件会触发 react-refresh 的 only-export-components 警告。

import BookmarkIcon from "@mui/icons-material/Bookmark";
import CodeIcon from "@mui/icons-material/Code";
import DescriptionIcon from "@mui/icons-material/Description";
import FavoriteIcon from "@mui/icons-material/Favorite";
import FlightIcon from "@mui/icons-material/Flight";
import FolderIcon from "@mui/icons-material/Folder";
import FitnessCenterIcon from "@mui/icons-material/FitnessCenter";
import HomeIcon from "@mui/icons-material/Home";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import PhotoCameraIcon from "@mui/icons-material/PhotoCamera";
import ShoppingCartIcon from "@mui/icons-material/ShoppingCart";
import SchoolIcon from "@mui/icons-material/School";
import WorkIcon from "@mui/icons-material/Work";

/** 可选颜色（十六进制）。渲染端按原样上色；不在清单里的值按「无颜色」画 */
export const FOLDER_COLORS = [
    "#b0433a", // 红（与默认强调色同族）
    "#3b82f6", // 蓝
    "#22c55e", // 绿
    "#eab308", // 黄
    "#14b8a6", // 青
    "#8b5cf6", // 紫
    "#6b7280", // 灰
    "#334155", // 墨
] as const;

/** 颜色值是否合法（存进库前与渲染前各查一次） */
export function isFolderColor(value: string | null | undefined): value is string {
    return typeof value === "string" && (FOLDER_COLORS as readonly string[]).includes(value);
}

/**
 * 可选图标清单（icon 名 → 组件）。存进库的是 **key**，不是组件 ——
 * 渲染端按 key 查表，查不到（脏数据/旧版本）就回落到第一项「默认」。
 * 新增图标只要在这里加一行，老数据不受影响。
 */
export const FOLDER_ICONS: { key: string; label: string; icon: typeof FolderIcon }[] = [
    { key: "", label: "默认", icon: FolderIcon },
    { key: "work", label: "工作", icon: WorkIcon },
    { key: "book", label: "笔记", icon: DescriptionIcon },
    { key: "school", label: "学习", icon: SchoolIcon },
    { key: "code", label: "代码", icon: CodeIcon },
    { key: "cart", label: "购物", icon: ShoppingCartIcon },
    { key: "travel", label: "旅行", icon: FlightIcon },
    { key: "home", label: "生活", icon: HomeIcon },
    { key: "photo", label: "相册", icon: PhotoCameraIcon },
    { key: "music", label: "音乐", icon: MusicNoteIcon },
    { key: "fitness", label: "健身", icon: FitnessCenterIcon },
    { key: "fav", label: "收藏", icon: FavoriteIcon },
    { key: "star", label: "星标", icon: BookmarkIcon },
];

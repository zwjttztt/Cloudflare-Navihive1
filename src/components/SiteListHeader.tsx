// src/components/SiteListHeader.tsx
// 顶栏：拆成上下两层。
//   第一层 = 品牌状态行（站名 + 时钟），第二层 = 核心工具行（搜索 / 显示 / 新增 / 更多）。
// 这样站名变长、或者按钮变多时，挤的是各自那一行，不会把搜索框压扁。
// 它不持有任何状态：时钟与工具都作为插槽由 App 透传。
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

export interface SiteListHeaderProps {
    /** 站名（settings 里配的 site.name） */
    siteName: string;
    /** 向下滚动后是否进入紧凑模式（**只改字号，不改间距/盒高**）。
     *  紧凑态**不再通过 CSS 类表达**（原来的 `.nav-header-compact` 已删）：
     *  唯一表现是下面标题的 fontSize 三元，理由见容器 sx 的注释。 */
    headerCompact: boolean;
    /** 第一层右侧：时钟。窄屏自己隐藏，这里只管位置。
     *  compact 也由 App 直接传进 HeaderClock，这里不关心。 */
    clock?: ReactNode;
    /** 第二层：搜索框 + 显示控制 + 新增 + 设置，由 App 透传 */
    actions: ReactNode;
}

export default function SiteListHeader({
    siteName,
    headerCompact,
    clock,
    actions,
}: SiteListHeaderProps) {
    return (
        <Box
            component="header"
            sx={{
                display: "flex",
                flexDirection: "column",
                // ⚠️ 间距**不跟随** headerCompact 变化（历史版本这里是三处三元）。
                //
                // 为什么必须拍平：间距一变，头部盒子高度就跟着变 —— 三处一起收时
                // 整页文档高度少 ~21px，滚动位置相对内容整体平移，于是滚动条 thumb
                // 重算、吸顶元素重新吸附、列表整体跳一下。而间距是在**滚动过程中**
                // 变的，这个平移正好发生在用户手指还在滚的时候，看起来就是「抖」。
                //
                // F1 的滞回（useViewportUi 的 160/130）已经把「临界点逐帧翻面」按住了，
                // 但「不产生位移」永远优于「产生位移再用滞回兜住」：滞回能防住来回抽搐，
                // 防不住那一次性的 21px 位移。所以这里直接把位移的源头去掉。
                //
                // 字号那处三元**保留**（见下面 Typography）：字号变化只改字形、行盒由
                // line-height 撑，不会改变盒高，因此不产生任何位移 —— 视觉效果还在。
                //
                // 同时**不再挂 `.nav-header-compact` 这个 class**（2026-11 删）：
                // 它那条 `transition: padding / background` 全是死声明（padding 已恒定、
                // background 从没人改过），留在头上只会让人以为「CSS 里还藏着一段收紧逻辑」。
                // 现在紧凑态的唯一表现就是标题字号 —— 盒高恒定是零位移的前提，刻意如此。
                gap: 1.5,
                mb: 3.5,
                pt: 0.5,
                // 这里原来有一句 `transition: "margin .25s ease"`，现已删除：
                // margin / padding 三处都成了常量，不可能再变化，这条过渡是**死声明**；
                // 留着会误导后来人以为「间距还在动，只是被滞回兜住了」。
                // 现在唯一还在过渡的属性是标题的 font-size，它自带
                // `transition: "font-size .25s ease"`（见下方 Typography）。
            }}
        >
            {/* 第一层：站名 + 时钟。站名不再和工具抢同一行的宽度 */}
            <Box
                sx={{
                    display: "flex",
                    // H1（24–32px）和时钟（13px）字号差了 20px：只有 baseline 才读作
                    // 「同一行文字的两端」。center 对齐是拿小块的盒子中心去对标题中心，
                    // 视觉上时钟会浮到站名右上方。
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 2,
                    minWidth: 0,
                }}
            >
                <Typography
                    variant="h3"
                    component="h1"
                    noWrap
                    sx={{
                        fontWeight: "bold",
                        color: "text.primary",

                        // 原来最大 3rem：站名一长就把工具行挤到换行，现在收到 32px
                        fontSize: headerCompact
                            ? { xs: "1.25rem", sm: "1.5rem", md: "1.75rem" }
                            : { xs: "1.5rem", sm: "1.75rem", md: "2rem" },

                        textAlign: { xs: "center", sm: "left" },
                        minWidth: 0,
                        transition: "font-size .25s ease"
                    }}>
                    {siteName}
                </Typography>
                {clock}
            </Box>

            {/* 第二层：核心工具行。窄屏上搜索整行独占，其余控件按需隐藏 */}
            <Box
                className="nav-header-tools"
                sx={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    columnGap: { xs: 1, sm: 1.5 },
                    rowGap: 1.25,
                    justifyContent: { xs: "center", sm: "flex-start" },
                }}
            >
                {actions}
            </Box>
        </Box>
    );
}

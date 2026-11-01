// src/components/navigationCenter/panels/DataSafetyPanel.tsx
// 中心里的「数据安全」面板（A+B 方案，2026-10-31）：原「备份与恢复」+「回收站」
// 两个面板合并成一个讲完整故事的地方 —— 怎么不丢（备份）、怎么找回（回收站）、
// 留多久（数据保留策略，从「数据与同步」迁来 —— 规则跟着被管的东西走）。
//
// 版式：自然流式长页（数据保留 → 备份与恢复 → 回收站），整体交给外壳的
// 面板正文滚动（panelScrollChain 钉的那层 overflowY:auto）。
// 备份/回收站两个业务体各自的内部滚动容器声明原样保留（source 级守卫还盯着），
// 只是在流式布局里高度变为自动、不再各自起滚动 —— 页签随页面一起滚，这是
// 合并长页的预期行为，不是回归。
//
// ⚠️ 这个文件是**懒加载面板块**：只能被 NavigationCenterDialog 用 lazy(() => import(...))
//    引入，任何静态 import 都会把它焊进首屏（tests/navigationCenterLazyGuard.test.ts 盯着）。
import Box from "@mui/material/Box";
import { BackupPanel as BackupBody } from "../../BackupDialog";
import { RecyclePanel as RecycleBody } from "../../RecycleBinDialog";
import RetentionPolicySection from "../../RetentionPolicySection";
import { SectionHeading } from "../../dialogSection";
import type { BackupCenterPanelProps } from "./BackupPanel";
import type { RecycleCenterPanelProps } from "./RecyclePanel";
import type { ConfigCenterPanelProps } from "./ConfigPanel";

export interface DataSafetyPanelProps {
    backup: BackupCenterPanelProps;
    recycle: RecycleCenterPanelProps;
    /** 只取数据保留三字段需要的部分（tempConfigs / onConfigInputChange / isSiteOwner） */
    config: ConfigCenterPanelProps;
}

export default function DataSafetyPanel({ backup, recycle, config }: DataSafetyPanelProps) {
    return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {/* 1. 数据保留：管的是下面两节（回收站 / 审计）的过期清除规则 */}
            <RetentionPolicySection
                tempConfigs={config.tempConfigs}
                onConfigInputChange={config.onConfigInputChange}
                isSiteOwner={config.isSiteOwner ?? true}
            />

            {/* 2. 备份与恢复：业务体原样复用（本地/WebDAV 备份、恢复、导入预览） */}
            <Box>
                <SectionHeading title='备份与恢复' sx={{ mb: 1.5 }} />
                <BackupBody {...backup} />
            </Box>

            {/* 3. 回收站：站点/分组还原与彻底删除；保留天数读的是上面的 retention.days */}
            <Box>
                <SectionHeading title='回收站' sx={{ mb: 1.5 }} />
                <RecycleBody {...recycle} />
            </Box>
        </Box>
    );
}

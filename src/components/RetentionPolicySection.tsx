// src/components/RetentionPolicySection.tsx
// 「数据保留」小节（2026-10-31 从 SettingsDialog 的「数据」页签迁出）。
//
// 为什么迁家：这三个字段决定的是「回收站和审计日志里的过期数据什么时候真的消失」
// —— 规则跟着被管的东西走。它们原先住在「数据与同步」（管的是离线/同步）里，
// 与被管的回收站隔着两个分组；A+B 方案（用户确认）把它们挪进设置中心新合成的
// 「数据安全」面板（备份与恢复 + 回收站 + 保留策略，一个讲完整数据安全故事的地方）。
//
// ⚠️ 独立成文件而不是留在 SettingsDialog 里导出：设置中心「数据安全」面板
// （panels/DataSafetyPanel，懒加载块）要引用它，从 SettingsDialog 导入会把整个
// 设置弹窗的业务块拖进数据安全块 —— 小组件单独成文件，两边各拿各的。
import type { ChangeEvent } from "react";
import Alert from "@mui/material/Alert";
import TextField from "@mui/material/TextField";
import Box from "@mui/material/Box";
import { Section } from "./dialogSection";
import {
    RETENTION_DAYS,
    RETENTION_DAYS_MIN,
    RETENTION_DAYS_MAX,
    INACTIVE_DISABLE_DAYS_DEFAULT,
    INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
} from "../API/http";

/** 窄屏堆叠、宽屏并排的两列栅格（与 SettingsDialog 内的同款，独立成小件避免跨块引用） */
function TwoCol({ children }: { children: React.ReactNode }) {
    return (
        <Box
            sx={{
                display: "grid",
                gap: 1.25,
                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
            }}
        >
            {children}
        </Box>
    );
}

export interface RetentionPolicySectionProps {
    tempConfigs: Record<string, string>;
    onConfigInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
    /** 三项都是全站共享配置：非所有者禁用并说明原因（服务端同规则） */
    isSiteOwner: boolean;
}

export default function RetentionPolicySection({
    tempConfigs,
    onConfigInputChange,
    isSiteOwner,
}: RetentionPolicySectionProps) {
    return (
        <Section title='数据保留'>
            {!isSiteOwner ? (
                <Alert severity='info' sx={{ mb: 1 }}>
                    这几项是全站设置，只有站点所有者可以修改；保存时服务端也会拒绝。
                </Alert>
            ) : null}
            {/* 沉睡治理两个阈值（v3.1.1 按用户要求恢复给所有者配置）：普通账号
                仍会被自动停用/清除，所有者本人永不被治理，但阈值归所有者调。 */}
            <TwoCol>
                <TextField
                    margin='dense'
                    size='small'
                    id='retention-days'
                    name='retention.days'
                    label='审计与回收站保留（天）'
                    type='number'
                    fullWidth
                    variant='outlined'
                    disabled={!isSiteOwner}
                    value={tempConfigs["retention.days"] ?? String(RETENTION_DAYS)}
                    onChange={onConfigInputChange}
                    helperText={`到期自动清除（${RETENTION_DAYS_MIN}-${RETENTION_DAYS_MAX}，默认 ${RETENTION_DAYS}）`}
                    slotProps={{
                        htmlInput: { min: RETENTION_DAYS_MIN, max: RETENTION_DAYS_MAX }
                    }}
                />
                <TextField
                    margin='dense'
                    size='small'
                    id='inactive-disable-days'
                    name='inactive.disableDays'
                    label='多久没登录算沉睡（天）'
                    type='number'
                    fullWidth
                    variant='outlined'
                    disabled={!isSiteOwner}
                    value={tempConfigs["inactive.disableDays"] ?? ""}
                    onChange={onConfigInputChange}
                    placeholder={String(INACTIVE_DISABLE_DAYS_DEFAULT)}
                    helperText={`停用沉睡账号，数据保留（默认 ${INACTIVE_DISABLE_DAYS_DEFAULT} 天）；所有者不受影响。`}
                    slotProps={{
                        htmlInput: { min: 30 }
                    }}
                />
            </TwoCol>
            <TextField
                margin='dense'
                size='small'
                id='inactive-grace-days'
                name='inactive.deleteGraceDays'
                label='停用后再过多久彻底删除（天）'
                type='number'
                fullWidth
                variant='outlined'
                disabled={!isSiteOwner}
                value={tempConfigs["inactive.deleteGraceDays"] ?? ""}
                onChange={onConfigInputChange}
                placeholder={String(INACTIVE_DELETE_GRACE_DAYS_DEFAULT)}
                helperText={`期间重新登录即可恢复，到期才彻底删除（默认 ${INACTIVE_DELETE_GRACE_DAYS_DEFAULT} 天）。`}
                slotProps={{
                    htmlInput: { min: 1 }
                }}
            />
        </Section>
    );
}

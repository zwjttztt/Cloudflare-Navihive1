// 断网提示 + 同步失败清单。
// 注意：离线改动会暂存本地（见 src/API/offlineQueue），联网后自动重放，
// 文案要说明「已暂存、会自动同步」，不能再写「存不到服务器、等恢复再操作一次」。
//
// 下半截是「可查看失败队列」：重试到上限或服务端明确拒绝的操作会从待同步队列移到这里。
// 它们不再占着角标，但必须让用户看得见 —— 悄悄丢掉等于骗人「都同步好了」。
import { useEffect, useState } from "react";
import { Alert, Box, Button, Collapse, Stack, Typography } from "@mui/material";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import ReportProblemIcon from "@mui/icons-material/ReportOutlined";
import {
    clearFailedMutations,
    discardFailedMutation,
    failedMutations,
    pendingCount,
    retryFailedMutation,
    subscribe,
    type FailedMutation,
} from "../API/offlineQueue";

/** 把操作名翻成人话；认不出来的就原样显示 */
const KIND_LABEL: Record<string, string> = {
    createGroup: "新建分组",
    updateGroup: "编辑分组",
    deleteGroup: "删除分组",
    createSite: "新建卡片",
    updateSite: "编辑卡片",
    deleteSite: "删除卡片",
    setConfig: "保存设置",
    setConfigs: "批量保存设置",
    deleteConfig: "删除设置",
    updateGroupOrder: "分组排序",
    updateSiteOrder: "卡片排序",
    importData: "恢复备份",
};

function describe(item: FailedMutation): string {
    const label = KIND_LABEL[item.kind] ?? item.kind;
    const first = item.args?.[0];
    let name = "";
    if (first && typeof first === "object") {
        const obj = first as { name?: unknown; key?: unknown };
        if (typeof obj.name === "string") name = obj.name;
        else if (typeof obj.key === "string") name = obj.key;
    }
    return name ? `${label}（${name}）` : label;
}

export default function OfflineBanner() {
    const [offline, setOffline] = useState(
        () => typeof navigator !== "undefined" && navigator.onLine === false
    );
    const [justBackOnline, setJustBackOnline] = useState(false);
    // 离线期间排进队列、等待联网后同步的改动数量（实时订阅，入队/重放/放回都会刷新）
    const [pending, setPending] = useState(() => pendingCount());
    const [failed, setFailed] = useState<FailedMutation[]>(() => failedMutations());
    const [showFailed, setShowFailed] = useState(false);

    useEffect(
        () =>
            subscribe(() => {
                setPending(pendingCount());
                setFailed(failedMutations());
            }),
        []
    );

    useEffect(() => {
        let timer: number | undefined;
        const onOffline = () => {
            setOffline(true);
            setJustBackOnline(false);
        };
        const onOnline = () => {
            setOffline(false);
            setJustBackOnline(true);
            timer = window.setTimeout(() => setJustBackOnline(false), 2600);
        };
        window.addEventListener("offline", onOffline);
        window.addEventListener("online", onOnline);
        return () => {
            window.removeEventListener("offline", onOffline);
            window.removeEventListener("online", onOnline);
            if (timer) window.clearTimeout(timer);
        };
    }, []);

    // 失败项要一直可见，不随「网络已恢复」那 2.6 秒一起消失
    if (!offline && !justBackOnline && failed.length === 0) return null;

    const retryAll = () => {
        for (const item of failedMutations()) {
            if (item.opId) retryFailedMutation(item.opId);
        }
    };

    return (
        <Box
            role='status'
            aria-live='polite'
            sx={{
                position: "fixed",
                top: 10,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: t => t.zIndex.snackbar + 1,
                width: { xs: "calc(100% - 20px)", sm: "auto" },
                maxWidth: 460,
                // 这条浮在最上层，别挡住下面的操作
                pointerEvents: "none",
                transition: "opacity .2s ease",
            }}
        >
            <Stack spacing={1}>
                {(offline || justBackOnline) && (
                    <Alert
                        severity={offline ? "warning" : "success"}
                        icon={offline ? <CloudOffIcon fontSize='inherit' /> : <CloudDoneIcon fontSize='inherit' />}
                        sx={{
                            borderRadius: "14px",
                            boxShadow: "var(--glass-shadow-hover)",
                            pointerEvents: "auto",
                        }}
                    >
                        {offline
                            ? `网络已断开：改动已暂存本地${pending > 0 ? `（${pending} 项待同步）` : ""}，联网后自动同步`
                            : "网络已恢复"}
                    </Alert>
                )}

                {failed.length > 0 && (
                    <Alert
                        severity='error'
                        icon={<ReportProblemIcon fontSize='inherit' />}
                        action={
                            <Stack direction='row' spacing={0.5}>
                                <Button
                                    color='inherit'
                                    size='small'
                                    onClick={() => setShowFailed(v => !v)}
                                    aria-expanded={showFailed}
                                >
                                    {showFailed ? "收起" : "查看"}
                                </Button>
                                <Button color='inherit' size='small' onClick={retryAll}>
                                    全部重试
                                </Button>
                            </Stack>
                        }
                        sx={{
                            borderRadius: "14px",
                            boxShadow: "var(--glass-shadow-hover)",
                            pointerEvents: "auto",
                            alignItems: "center",
                        }}
                    >
                        {failed.length} 项改动没能同步（已停止重试，可手动重试或放弃）
                    </Alert>
                )}

                <Collapse in={showFailed} unmountOnExit>
                    <Box
                        sx={{
                            pointerEvents: "auto",
                            bgcolor: "background.paper",
                            border: 1,
                            borderColor: "divider",
                            borderRadius: "14px",
                            boxShadow: "var(--glass-shadow-hover)",
                            p: 1.5,
                            maxHeight: 280,
                            overflowY: "auto",
                        }}
                    >
                        <Stack spacing={1.25}>
                            {failed.map(item => (
                                <Box key={item.opId ?? `${item.kind}-${item.failedAt}`}>
                                    <Typography variant='body2' sx={{
                                        fontWeight: 600
                                    }}>
                                        {describe(item)}
                                    </Typography>
                                    <Typography variant='caption' component='div' sx={{
                                        color: 'text.secondary'
                                    }}>
                                        {item.reason}
                                    </Typography>
                                    <Stack direction='row' spacing={0.5} sx={{ mt: 0.5 }}>
                                        <Button
                                            size='small'
                                            variant='outlined'
                                            onClick={() => item.opId && retryFailedMutation(item.opId)}
                                        >
                                            重试
                                        </Button>
                                        <Button
                                            size='small'
                                            color='inherit'
                                            onClick={() => item.opId && discardFailedMutation(item.opId)}
                                        >
                                            放弃
                                        </Button>
                                    </Stack>
                                </Box>
                            ))}
                            <Button
                                size='small'
                                color='inherit'
                                onClick={() => {
                                    clearFailedMutations();
                                    setShowFailed(false);
                                }}
                            >
                                清空清单
                            </Button>
                        </Stack>
                    </Box>
                </Collapse>
            </Stack>
        </Box>
    );
}

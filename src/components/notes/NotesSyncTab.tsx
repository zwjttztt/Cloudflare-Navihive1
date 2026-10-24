// src/components/notes/NotesSyncTab.tsx
// 记事本设置·同步页（2026-10-24 从 NotesSettingsDialog.tsx 拆出）。
// 跨设备变更轮询的**本机**偏好：开关 + 间隔。偏好存 localStorage 按账号分桶，
// 打开设置时读一次，改动立即落盘 + 生效（轮询每轮重读偏好）。

import { useState } from "react";
import Box from "@mui/material/Box";
import Slider from "@mui/material/Slider";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { loadNotesSyncPrefs, saveNotesSyncPrefs, type NotesSyncPrefs } from "../../utils/notesSync";
import { SettingRow } from "./settingsShared";

export default function NotesSyncTab() {
    const [syncPrefs, setSyncPrefs] = useState<NotesSyncPrefs>(() => loadNotesSyncPrefs());
    const setSyncPref = (patch: Partial<NotesSyncPrefs>) => {
        setSyncPrefs(prev => {
            const next = { ...prev, ...patch };
            saveNotesSyncPrefs(next);
            return next;
        });
    };
    return (
                            <Box data-settings-sync='1'>
                                <SettingRow
                                    label='跨设备变更提示'
                                    description='其他设备改动后本机自动刷新（不覆盖编辑中的草稿）'
                                >
                                    <Switch
                                        checked={syncPrefs.enabled}
                                        onChange={e => setSyncPref({ enabled: e.target.checked })}
                                        data-setting='syncEnabled'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='检查间隔' description='多久向服务器问一次「有没有其他设备的改动」'>
                                    <Slider
                                        aria-label='同步检查间隔'
                                        data-setting='syncIntervalSec'
                                        value={syncPrefs.intervalSec}
                                        min={30}
                                        max={600}
                                        step={30}
                                        valueLabelDisplay='auto'
                                        disabled={!syncPrefs.enabled}
                                        onChange={(_, v) => setSyncPref({ intervalSec: v as number })}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 52, textAlign: "right" }}>
                                        {syncPrefs.intervalSec}s
                                    </Typography>
                                </SettingRow>
                                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 1.5 }}>
                                    这里的开关只影响本机；其他设备保持各自的设置。同一账号开多个标签页时，只有一个标签页会真正发检查请求。
                                </Typography>
                            </Box>
    );
}

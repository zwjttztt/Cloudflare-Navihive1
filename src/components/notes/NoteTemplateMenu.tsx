// src/components/notes/NoteTemplateMenu.tsx
// 「新建笔记」点开时的模板选择（B3，2026-10-22）。
//
// 为什么做成菜单而不是设置里加一个「默认模板」：模板是**每次新建时**的选择，
// 写日报和写会议记录的人在一天里会交替。做成默认偏好反而要多想一步
// 「现在这个默认值对不对」—— 一个菜单点两下就完事。
//
// 「空白笔记」放在第一项：大多数时候就是想啥也不带地开一篇，
// 不该为了用模板多点一次。键盘也能一路选（Menu 自带方向键 + Enter）。
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import NoteAddOutlinedIcon from "@mui/icons-material/NoteAddOutlined";
import TodayOutlinedIcon from "@mui/icons-material/TodayOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import type { NoteTemplateId } from "../../utils/noteTemplates";
import { NOTE_TEMPLATES } from "../../utils/noteTemplates";

const ICONS: Record<NoteTemplateId, typeof TodayOutlinedIcon> = {
    daily: TodayOutlinedIcon,
    meeting: GroupsOutlinedIcon,
    reading: MenuBookOutlinedIcon,
};

export interface NoteTemplateMenuProps {
    anchorEl: HTMLElement | null;
    open: boolean;
    onPick: (templateId: NoteTemplateId | null) => void;
    onClose: () => void;
}

export default function NoteTemplateMenu({ anchorEl, open, onPick, onClose }: NoteTemplateMenuProps) {
    const pick = (id: NoteTemplateId | null) => {
        onClose();
        onPick(id);
    };
    return (
        <Menu
            open={open}
            anchorEl={anchorEl}
            onClose={onClose}
            // 锚点是那颗 28px 的小图标钮，菜单往左下展开（inkstone 同款）
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
            slotProps={{ paper: { sx: { minWidth: 240 } } }}
        >
            <MenuItem data-template='blank' onClick={() => pick(null)}>
                <NoteAddOutlinedIcon fontSize='small' sx={{ mr: 1.5, fontSize: 18, opacity: 0.75 }} />
                <Box sx={{ minWidth: 0 }}>
                    <Typography variant='body2' sx={{ fontSize: 13.5 }}>空白笔记</Typography>
                    <Typography variant='caption' color='text.secondary' sx={{ fontSize: 11 }}>
                        从零开始
                    </Typography>
                </Box>
            </MenuItem>
            <Divider />
            {NOTE_TEMPLATES.map(t => {
                const Icon = ICONS[t.id];
                return (
                    <MenuItem
                        key={t.id}
                        data-template={t.id}
                        onClick={() => pick(t.id)}
                    >
                        <Icon fontSize='small' sx={{ mr: 1.5, fontSize: 18, opacity: 0.75 }} />
                        <Box sx={{ minWidth: 0 }}>
                            <Typography variant='body2' sx={{ fontSize: 13.5 }}>{t.label}</Typography>
                            <Typography variant='caption' color='text.secondary' sx={{ fontSize: 11 }}>
                                {t.hint}
                            </Typography>
                        </Box>
                    </MenuItem>
                );
            })}
        </Menu>
    );
}

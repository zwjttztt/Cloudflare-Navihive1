// src/components/PasswordField.tsx
// 带「显示 / 隐藏」切换的密码输入框。
// 两个目的：
//   1. 长随机密码（或浏览器自动填进来的内容）能肉眼确认，避免“填了但不知道填了什么”；
//   2. 默认关掉浏览器自动填充（autoComplete="new-password"），防止密码管理器把
//      当前站点的登录账号密码直接带进「修改管理员密码」这类表单里。
// 组件本身不持有业务状态，显示与否是纯 UI 状态，跟随组件生命周期。
import type { ChangeEvent, KeyboardEvent } from "react";
import { useState } from "react";
import { IconButton, InputAdornment, TextField } from "@mui/material";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";

interface PasswordFieldProps {
    id?: string;
    label: string;
    value: string;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    helperText?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    fullWidth?: boolean;
    /** 有换行提交需求的弹窗用（如「输入当前密码」弹窗里的回车提交） */
    onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
    /**
     * 自动填充策略。默认 new-password：明确告诉浏览器这是「新密码」，
     * 不要拿已保存的登录凭据来填。确实想让浏览器填的场景才传 "current-password"。
     */
    autoComplete?: string;
}

export function PasswordField({
    id,
    label,
    value,
    onChange,
    placeholder,
    helperText,
    disabled,
    autoFocus,
    fullWidth = true,
    onKeyDown,
    autoComplete = "new-password",
}: PasswordFieldProps) {
    const [visible, setVisible] = useState(false);

    return (
        <TextField
            margin='dense'
            size='small'
            variant='outlined'
            id={id}
            label={label}
            // 关掉自动填充还不够，浏览器会对同名/同 id 的字段记忆填充，这里一并给个不参与填充的信号
            name={id ? `${id}-field` : undefined}
            type={visible ? "text" : "password"}
            autoComplete={autoComplete}
            value={value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            helperText={helperText}
            disabled={disabled}
            autoFocus={autoFocus}
            fullWidth={fullWidth}
            InputProps={{
                endAdornment: (
                    <InputAdornment position='end'>
                        <IconButton
                            aria-label={visible ? "隐藏密码" : "显示密码"}
                            title={visible ? "隐藏密码" : "显示密码"}
                            onClick={() => setVisible(v => !v)}
                            // 别让点击把输入框焦点抢走：否则一切换就失焦，体验很别扭
                            onMouseDown={e => e.preventDefault()}
                            edge='end'
                            size='small'
                            disabled={disabled}
                        >
                            {visible ? (
                                <VisibilityOffIcon fontSize='small' />
                            ) : (
                                <VisibilityIcon fontSize='small' />
                            )}
                        </IconButton>
                    </InputAdornment>
                ),
            }}
        />
    );
}

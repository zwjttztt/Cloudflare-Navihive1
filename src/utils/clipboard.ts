// 复制到剪贴板的工具函数
// 优先使用异步 Clipboard API，在不支持或非安全上下文（http）时回落到 execCommand

export async function copyToClipboard(text: string): Promise<boolean> {
    if (!text) {
        return false;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 继续尝试回落方案
    }

    try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "fixed";
        textArea.style.top = "-9999px";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        textArea.setSelectionRange(0, textArea.value.length);

        const ok = document.execCommand("copy");
        document.body.removeChild(textArea);
        return ok;
    } catch {
        return false;
    }
}

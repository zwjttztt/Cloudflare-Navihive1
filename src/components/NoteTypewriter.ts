// 打字机模式（inkstone 的 `editor/decorations.ts: typewriterPlugin`）。
//
// 光标行始终停在视口垂直中间，写作时眼睛不用来回跳。
//
// 两个必须遵守的细节（抄 inkstone 的做法）：
//   1. **只在键盘操作时接管**。鼠标拖选是在选文字、不是在写作，
//      这时强制居中会让视口跟着选区乱跑。inkstone 用 mouseSelection 标志位判断。
//   2. **只滚视口，不动装饰**。它是个纯 ViewPlugin，靠改 scrollTop 把光标行挪到中间，
//      所以和「专注模式」「即时渲染」的装饰互不干扰。
import { Compartment, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

/** 打字机模式的开关用 Compartment 热插拔，和即时渲染一样不重建编辑器（不丢撤销历史）。 */
export const typewriterCompartment = new Compartment();

/**
 * 打字机滚动：把光标行滚到视口垂直正中。
 *
 * 只在「滚动位置确实需要动」时才写 scrollTop —— 差值小于 1px 就跳过，
 * 否则每次按键都会触发一次 scroll 事件，滚动同步（预览跟随）跟着抖。
 */
export function typewriter(): Extension {
    return ViewPlugin.fromClass(
        class {
            /** 鼠标拖选中：此时不接管滚动 */
            private mouseSelection = false;
            private disposers: (() => void)[] = [];

            constructor(private readonly view: EditorView) {
                // ⚠️ addEventListener 返回的是 **void**，不是取消函数 ——
                // 以前直接把返回值塞进 disposers，类型就打架（TS2345），
                // 而且真到了销毁时也压根卸不掉监听。这里老老实实写包装函数。
                const onMouseDown = () => {
                    this.mouseSelection = true;
                };
                const onMouseUp = () => {
                    // 放开后等一拍再恢复接管：mouseup 早于 selection 变更，
                    // 立刻接管会把「点一下定位光标」也误判成拖选。
                    setTimeout(() => {
                        this.mouseSelection = false;
                        this.center();
                    }, 0);
                };
                this.view.dom.addEventListener("mousedown", onMouseDown);
                this.view.dom.addEventListener("mouseup", onMouseUp);
                this.disposers.push(
                    () => this.view.dom.removeEventListener("mousedown", onMouseDown),
                    () => this.view.dom.removeEventListener("mouseup", onMouseUp)
                );
            }

            update(update: ViewUpdate) {
                if (update.docChanged || update.selectionSet) this.center();
            }

            private center(): void {
                if (this.mouseSelection) return;
                const view = this.view;
                const scroller = view.scrollDOM;
                const head = view.state.selection.main.head;
                const block = view.lineBlockAt(head);
                const target = block.top - (scroller.clientHeight - block.height) / 2;
                const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                const next = Math.min(max, Math.max(0, target));
                if (Math.abs(next - scroller.scrollTop) > 1) scroller.scrollTop = next;
            }

            destroy(): void {
                for (const dispose of this.disposers) dispose();
                this.disposers = [];
            }
        }
    );
}

// src/utils/concurrency.ts
// 纯异步控制流工具（零依赖，不许 import 任何 API/ 下东西）。
//
// mapWithConcurrency 原本长在 API/methods/transfer.ts 里 —— 但它是纯函数、
// 与 D1/SQL 毫无关系。钩子（useBookmarkImport）要用它，一 import 就把 1600+ 行
// 带 D1 语句的后端方法层整个拖进前端依赖图。搬到这里之后，
// transfer.ts 保留一行再导出，既有测试的 import 路径不用改。

/**
 * 限并发地跑一遍异步映射：同时最多 `limit` 个在飞，输出顺序与输入一致。
 *
 * 抽出来是因为「并发窗口到底生效没有」必须能被验证 —— 埋在 encryptSitePasswords
 * 里就只能靠计时猜。这里是个纯函数，测试可以直接数在飞的数量。
 * `limit` 会被夹到 [1, items.length]：0 会永久挂住，超过条目数则是白开几条空车道。
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
    onProgress?: (done: number, total: number) => void
): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let done = 0;
    // 取件走 entries() 而不是 `items[cursor++]`：严格层（noUncheckedIndexedAccess）下
    // 任何下标读都是 `T | undefined`，而这里的下标由循环条件保证有效 —— 用 `!` 或
    // `as T` 都是把检查关掉，等于给未来留一个会崩的断言。entries() 给的是
    // `[number, T]` 元组，下标与值同时精确，且不多分配一个队列数组。
    // 并发安全：JS 单线程，两个 await 之间不会被别的 worker 插进来抢同一个 next()。
    const iterator = items.entries();

    const worker = async (): Promise<void> => {
        for (;;) {
            const step = iterator.next();
            if (step.done) return;
            const [index, item] = step.value;
            out[index] = await fn(item, index);
            done++;
            onProgress?.(done, items.length);
        }
    };

    const lanes = Math.min(Math.max(1, limit), Math.max(1, items.length));
    await Promise.all(Array.from({ length: lanes }, worker));
    return out;
}

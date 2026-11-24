/**
 * 読み込みに時間のかかる値（SSM のパラメータなど）を、決めた間だけ覚えておく。
 * 間が過ぎたら次の呼び出しで読み直す。読み直しに失敗したときは、覚えている値を返し続ける
 * （次に読み直すのは、また決めた間が過ぎてから）。最初の読み込みの失敗は、そのまま投げる
 */
export function cachedValue<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now) {
  let cached: { value: T; loadedAt: number } | undefined;
  return async (): Promise<T> => {
    if (cached && now() - cached.loadedAt < ttlMs) return cached.value;
    try {
      cached = { value: await load(), loadedAt: now() };
    } catch (e) {
      if (!cached) throw e;
      console.error("値を読み直せなかったため、前の値を使います", e);
      cached = { value: cached.value, loadedAt: now() };
    }
    return cached.value;
  };
}

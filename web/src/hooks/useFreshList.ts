import { useCallback, useRef } from "react";

/** 保存した直後の一覧の取得が古い内容を返しうる間（一覧は少し遅れて反映される） */
export const FRESH_MS = 10_000;

/**
 * 管理画面の一覧で、保存・削除の直後に一覧を取り直すと古い内容が返ることがある（一覧は少し遅れて反映される）。
 * そこで、保存の応答で受け取ったものと、削除したものを少しの間覚えておき、取り直した一覧に重ねる。
 * - saved: 保存したもの。FRESH_MS の間は、取り直した一覧より手元のものを優先し、一覧に無くても残す
 * - deleted: 削除したもの。取り直した一覧に残っていても出さない
 */
export function useFreshList<T>(idOf: (item: T) => string) {
  const fresh = useRef(new Map<string, T>());
  const deleted = useRef(new Set<string>());

  const saved = useCallback(
    (item: T) => {
      const id = idOf(item);
      fresh.current.set(id, item);
      deleted.current.delete(id);
      setTimeout(() => {
        if (fresh.current.get(id) === item) fresh.current.delete(id);
      }, FRESH_MS);
    },
    [idOf],
  );

  const removed = useCallback((id: string) => {
    deleted.current.add(id);
    fresh.current.delete(id);
  }, []);

  /** 取り直した一覧に、保存・削除したものを重ねる */
  const merge = useCallback(
    (fetched: T[]): T[] => {
      const list = fetched
        .filter((item) => !deleted.current.has(idOf(item)))
        .map((item) => fresh.current.get(idOf(item)) ?? item);
      const ids = new Set(list.map(idOf));
      const missing = [...fresh.current.values()].filter((item) => !ids.has(idOf(item)));
      return [...list, ...missing];
    },
    [idOf],
  );

  /** 手元の一覧にも、保存・削除をすぐ入れる */
  const apply = useCallback(
    (list: T[] | undefined): T[] | undefined => (list === undefined ? list : merge(list)),
    [merge],
  );

  return { saved, removed, merge, apply };
}

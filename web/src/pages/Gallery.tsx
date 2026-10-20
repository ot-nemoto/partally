import type { PhotoDto, PhotosResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { Lightbox } from "../components/Lightbox";
import { useAutoRefresh } from "../hooks/useAutoRefresh";

const POLL_INTERVAL_MS = 20_000;

/** 公開済みの写真を新しい順に表示する。新着は定期的に取り込む */
export function Gallery() {
  const [photos, setPhotos] = useState<PhotoDto[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<PhotoDto>();
  // 「もっと見る」の位置は初回の読み込み結果だけで決める（新着の取り込みでは動かさない）
  const cursorInitialized = useRef(false);

  const fetchLatest = useCallback(async () => {
    try {
      const res = await api<PhotosResponse>("GET", "/photos");
      setPhotos((prev) => {
        // 初回は丸ごと、以降は手元に無い新着だけを先頭に足す（削除された写真は次回の読み込みで消える）
        if (prev.length === 0) return res.photos;
        const known = new Set(prev.map((p) => p.photoId));
        return [...res.photos.filter((p) => !known.has(p.photoId)), ...prev];
      });
      if (!cursorInitialized.current) {
        cursorInitialized.current = true;
        setCursor(res.cursor);
      }
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void fetchLatest();
  }, [fetchLatest]);
  useAutoRefresh(fetchLatest, POLL_INTERVAL_MS);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await api<PhotosResponse>("GET", `/photos?cursor=${encodeURIComponent(cursor)}`);
      setPhotos((prev) => {
        const known = new Set(prev.map((p) => p.photoId));
        return [...prev, ...res.photos.filter((p) => !known.has(p.photoId))];
      });
      setCursor(res.cursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <h1>みんなの写真</h1>
      {error && <p className="error">{error}</p>}
      {loaded && photos.length === 0 && <p className="muted">まだ写真がありません。</p>}
      <div className="photo-grid">
        {photos.map((p) => (
          <button key={p.photoId} type="button" className="photo-tile" onClick={() => setSelected(p)}>
            <img src={p.thumbUrl} alt="" loading="lazy" />
          </button>
        ))}
      </div>
      {cursor && (
        <button type="button" className="more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "読み込み中…" : "もっと見る"}
        </button>
      )}
      {selected && <Lightbox photo={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}

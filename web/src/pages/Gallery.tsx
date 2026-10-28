import type { PhotoDto, PhotosResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { FavoriteButton } from "../components/FavoriteButton";
import { Lightbox } from "../components/Lightbox";
import { useParticipant } from "../components/ParticipantLayout";
import { useOnReload } from "../hooks/useReload";

/** 公開済みの写真を新しい順に表示する。新着は「更新」で取り込む。他の人の写真は ♡ でお気に入りに選べる */
export function Gallery() {
  const [photos, setPhotos] = useState<PhotoDto[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<PhotoDto>();
  const { user, rules } = useParticipant();
  // 「もっと見る」の位置は初回の読み込み結果だけで決める（新着の取り込みでは動かさない）
  const cursorInitialized = useRef(false);
  // お気に入りを付け外しした回数。取得中に操作されたら、古い応答で手元の状態を上書きしない
  const changeCount = useRef(0);

  const fetchLatest = useCallback(async () => {
    try {
      const startedAt = changeCount.current;
      const res = await api<PhotosResponse>("GET", "/photos");
      const stale = changeCount.current !== startedAt;
      setPhotos((prev) => {
        // 初回は丸ごと、以降は手元に無い新着を先頭に足し、手元にある写真はお気に入り数などを最新にする
        // （削除された写真は次回の読み込みで消える）
        if (prev.length === 0) return res.photos;
        const latest = new Map(stale ? [] : res.photos.map((p) => [p.photoId, p]));
        const known = new Set(prev.map((p) => p.photoId));
        return [...res.photos.filter((p) => !known.has(p.photoId)), ...prev.map((p) => latest.get(p.photoId) ?? p)];
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
  useOnReload(fetchLatest);

  /** お気に入りの付け外しの結果を一覧と拡大表示に反映する */
  function replacePhoto(photo: PhotoDto) {
    changeCount.current++;
    setPhotos((prev) => prev.map((p) => (p.photoId === photo.photoId ? photo : p)));
    setSelected((prev) => (prev?.photoId === photo.photoId ? photo : prev));
  }

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
      {rules.favoritesEnabled ? (
        <p className="muted small">
          気に入った写真の ♡ を押すとお気に入りに選べます（{user.favoritesGiven} / {rules.favoriteLimit} 枚選択中）。
          {rules.showPoints && rules.favoritePoints > 0 && `選ばれた人に ${rules.favoritePoints} ポイント入ります。`}
        </p>
      ) : (
        user.favoritesGiven > 0 && <p className="muted small">お気に入りの受付は終了しました（♥ が選んだ写真）。</p>
      )}
      {error && <p className="error">{error}</p>}
      {loaded && !error && !cursor && photos.length === 0 && <p className="muted">まだ写真がありません。</p>}
      <div className="photo-grid">
        {photos.map((p) => (
          <div key={p.photoId} className="photo-tile">
            <button type="button" onClick={() => setSelected(p)}>
              <img src={p.thumbUrl} alt="" loading="lazy" />
            </button>
            {/* 自分の写真には出ない。受付終了後は押せないが、選んだ写真は ♥ のまま見える */}
            <FavoriteButton photo={p} onChange={replacePhoto} compact />
          </div>
        ))}
      </div>
      {cursor && (
        <button type="button" className="more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "読み込み中…" : "もっと見る"}
        </button>
      )}
      {selected && (
        <Lightbox photo={selected} onClose={() => setSelected(undefined)}>
          <FavoriteButton photo={selected} onChange={replacePhoto} />
        </Lightbox>
      )}
    </>
  );
}

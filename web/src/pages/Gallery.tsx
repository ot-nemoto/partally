import type { PhotoDto, PhotosResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { FavoriteButton } from "../components/FavoriteButton";
import { Lightbox } from "../components/Lightbox";
import { useParticipant } from "../components/ParticipantLayout";
import { useT } from "../i18n";

/** 公開済みの写真を新しい順に表示する。新着は開き直したとき（画面を下に引っ張って読み込み直したときなど）に出る。他の人の写真は ♡ でお気に入りに選べる */
export function Gallery() {
  const [photos, setPhotos] = useState<PhotoDto[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<PhotoDto>();
  const { user, rules } = useParticipant();
  const t = useT();
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
      <h1>{t("みんなの写真", "Everyone’s photos")}</h1>
      {rules.favoritesEnabled ? (
        <p className="muted small">
          {t(
            `気に入った写真の ♡ を押すとお気に入りに選べます（${user.favoritesGiven} / ${rules.favoriteLimit} 枚選択中）。`,
            `Tap ♡ on a photo you like to make it a favorite (${user.favoritesGiven} / ${rules.favoriteLimit} chosen). `,
          )}
          {rules.showPoints && (
            <>
              {rules.favoritePoints > 0 &&
                t(
                  `選ばれた人に ${rules.favoritePoints} ポイント入ります。`,
                  `The photographer gets ${rules.favoritePoints} ${rules.favoritePoints === 1 ? "point" : "points"}. `,
                )}
              {rules.favoriteGivenPoints > 0 &&
                t(
                  `選んだあなたにも 1 枚につき ${rules.favoriteGivenPoints} ポイント入ります。`,
                  `You also get ${rules.favoriteGivenPoints} ${rules.favoriteGivenPoints === 1 ? "point" : "points"} for each one you choose.`,
                )}
            </>
          )}
        </p>
      ) : (
        user.favoritesGiven > 0 && (
          <p className="muted small">
            {t(
              "お気に入りの受付は終了しました（♥ が選んだ写真）。",
              "Favorites are closed (♥ marks the ones you chose).",
            )}
          </p>
        )
      )}
      {error && <p className="error">{error}</p>}
      {loaded && !error && !cursor && photos.length === 0 && (
        <p className="muted">{t("まだ写真がありません。", "No photos yet.")}</p>
      )}
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
          {loadingMore ? t("読み込み中…", "Loading…") : t("もっと見る", "Show more")}
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

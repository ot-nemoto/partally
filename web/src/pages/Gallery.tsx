import type { PhotoDto, PhotosResponse } from "@partally/shared";
import { useEffect, useState } from "react";
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
  // 画面を開いたときに 1 ページ目を読む（新着は、開き直したときに出る。#294）
  useEffect(() => {
    api<PhotosResponse>("GET", "/photos")
      .then((res) => {
        setPhotos(res.photos);
        setCursor(res.cursor);
        setError(undefined);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoaded(true));
  }, []);

  /** お気に入りの付け外しの結果を一覧と拡大表示に反映する */
  function replacePhoto(photo: PhotoDto) {
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

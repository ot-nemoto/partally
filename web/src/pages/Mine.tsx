import type { PhotoDto, PhotoStatus, PhotosResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { CaptureButtons } from "../components/CaptureButtons";
import { Lightbox } from "../components/Lightbox";
import { useOnReload } from "../hooks/useReload";
import { subscribeQueue } from "../photos/queue";

const STATUS_LABEL: Record<PhotoStatus, string> = {
  pending: "確認待ち",
  approved: "公開中",
  rejected: "非公開",
};

export function Mine() {
  const [photos, setPhotos] = useState<PhotoDto[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<PhotoDto>();

  // 送信後の取り直しと「更新」で読み込みが重なったとき、後から返ってきた古い応答で戻さない
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    api<PhotosResponse>("GET", "/photos/mine")
      .then((res) => {
        if (request !== latestRequest.current) return;
        setPhotos(res.photos);
        setError(undefined);
      })
      .catch((e) => request === latestRequest.current && setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);
  useOnReload(load);

  // 送信が終わるたびに一覧を取り直す（サーバ側の登録が少し遅れるので少し待つ）。画面を離れたら取り直さない
  useEffect(() => {
    let previous = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeQueue((s) => {
      if (s.waiting < previous) {
        clearTimeout(timer);
        timer = setTimeout(load, 1500);
      }
      previous = s.waiting;
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [load]);

  return (
    <>
      <h1>自分の写真</h1>
      <CaptureButtons />
      {error && <p className="error">{error}</p>}
      {photos?.length === 0 && <p className="muted">まだ写真がありません。</p>}
      <div className="photo-grid">
        {photos?.map((p) => (
          <div key={p.photoId} className="photo-tile">
            {p.thumbUrl ? (
              <button type="button" onClick={() => setSelected(p)}>
                <img src={p.thumbUrl} alt="" loading="lazy" />
              </button>
            ) : (
              <div className="photo-placeholder">非公開</div>
            )}
            <span className={`badge badge-${p.status}`}>{STATUS_LABEL[p.status]}</span>
          </div>
        ))}
      </div>
      {selected && (
        <Lightbox photo={selected} onClose={() => setSelected(undefined)}>
          <span className="small">
            {STATUS_LABEL[selected.status]}
            {selected.status === "approved" &&
              selected.favoriteCount !== undefined &&
              ` ・ ♥ ${selected.favoriteCount}`}
          </span>
        </Lightbox>
      )}
    </>
  );
}

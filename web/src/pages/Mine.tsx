import type { PhotoDto, PhotoStatus, PhotosResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { CaptureButtons } from "../components/CaptureButtons";
import { Lightbox } from "../components/Lightbox";
import { useOnReload } from "../hooks/useReload";

const STATUS_LABEL: Record<PhotoStatus, string> = {
  pending: "確認待ち",
  approved: "公開中",
  rejected: "非公開",
};

export function Mine() {
  const [photos, setPhotos] = useState<PhotoDto[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<PhotoDto>();

  // 「更新」を続けて押して読み込みが重なったとき、後から返ってきた古い応答で戻さない
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

  return (
    <>
      <h1>自分の写真</h1>
      <CaptureButtons onQueued={() => setTimeout(load, 3000)} />
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
      {photos && (
        <button type="button" className="more" onClick={load}>
          更新
        </button>
      )}
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

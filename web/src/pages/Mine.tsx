import type { PhotoDto, PhotoStatus, PhotosResponse } from "@partally/shared";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { CaptureButtons } from "../components/CaptureButtons";
import { Lightbox } from "../components/Lightbox";
import { useAutoRefresh } from "../hooks/useAutoRefresh";

const STATUS_LABEL: Record<PhotoStatus, string> = {
  pending: "確認待ち",
  approved: "公開中",
  rejected: "非公開",
};

export function Mine() {
  const [photos, setPhotos] = useState<PhotoDto[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<PhotoDto>();

  const load = useCallback(() => {
    api<PhotosResponse>("GET", "/photos/mine")
      .then((res) => setPhotos(res.photos))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);
  useAutoRefresh(load, 5 * 60 * 1000);

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

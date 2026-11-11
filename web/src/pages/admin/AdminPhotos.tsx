import type { PhotoDto, PhotoResponse, PhotoStatus, PhotosResponse, SettingsResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api";
import { formatTime, Lightbox } from "../../components/Lightbox";
import { PageTitle } from "../../components/PageTitle";
import { useOnReload } from "../../hooks/useReload";

const TABS: { status: PhotoStatus; label: string }[] = [
  { status: "pending", label: "確認待ち" },
  { status: "approved", label: "公開中" },
  { status: "rejected", label: "却下済み" },
];

export function AdminPhotos() {
  const [status, setStatus] = useState<PhotoStatus>("pending");
  const [photos, setPhotos] = useState<PhotoDto[]>();
  const [cursor, setCursor] = useState<string>();
  const [moderation, setModeration] = useState<string>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<PhotoDto>();
  /** 承認・却下・削除を送っている写真（同じ写真に二重に送らないよう、その間はボタンを押せなくする） */
  const [acting, setActing] = useState<ReadonlySet<string>>(new Set());
  const actingRef = useRef(new Set<string>());

  // タブの切り替えや「更新」で読み込みが重なったとき、後から返ってきた古い応答（別のタブの一覧）で上書きしない
  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const res = await api<PhotosResponse>("GET", `/admin/photos?status=${status}`);
      if (request !== latestRequest.current) return;
      setPhotos(res.photos);
      setCursor(res.cursor);
      setError(undefined);
    } catch (e) {
      if (request === latestRequest.current) setError(errorMessage(e));
    }
  }, [status]);

  useEffect(() => {
    setPhotos(undefined);
    void load();
  }, [load]);
  useOnReload(load);

  useEffect(() => {
    api<SettingsResponse>("GET", "/admin/settings")
      .then((res) => setModeration(res.settings.moderation))
      .catch(() => undefined);
  }, []);

  async function loadMore() {
    if (!cursor) return;
    try {
      const res = await api<PhotosResponse>(
        "GET",
        `/admin/photos?status=${status}&cursor=${encodeURIComponent(cursor)}`,
      );
      setPhotos((prev) => [...(prev ?? []), ...res.photos]);
      setCursor(res.cursor);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function act(photo: PhotoDto, action: "approve" | "reject" | "delete") {
    // 画面の更新を待たずに続けて押されても、2 回目は送らない
    if (actingRef.current.has(photo.photoId)) return;
    if (action === "delete" && !confirm("この写真を削除します。元に戻せません。よろしいですか？")) return;
    actingRef.current.add(photo.photoId);
    setActing(new Set(actingRef.current));
    try {
      if (action === "delete") await api("DELETE", `/admin/photos/${photo.photoId}`);
      else await api<PhotoResponse>("POST", `/admin/photos/${photo.photoId}/${action}`);
      setPhotos((prev) => prev?.filter((p) => p.photoId !== photo.photoId));
      setSelected(undefined);
    } catch (e) {
      alert(errorMessage(e));
      void load();
    } finally {
      actingRef.current.delete(photo.photoId);
      setActing(new Set(actingRef.current));
    }
  }

  return (
    <section>
      <PageTitle en="Photo" ja="写真の確認・管理">
        <div className="tabs title-actions">
          {TABS.map((t) => (
            <button
              key={t.status}
              type="button"
              className={t.status === status ? "active" : undefined}
              onClick={() => {
                // タブはスクロールしても画面の上に残るので、切り替えたら一覧の先頭から見せる
                window.scrollTo({ top: 0 });
                setStatus(t.status);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </PageTitle>
      {moderation && (
        <p className="muted">
          現在の公開方法：{moderation === "pre" ? "管理者が承認してから公開" : "アップロードと同時に公開"}（
          <Link to="/admin/settings">変更</Link>）
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {photos?.length === 0 && <p className="muted">該当する写真はありません。</p>}
      <div className="admin-photo-grid">
        {photos?.map((p) => (
          <div key={p.photoId} className="admin-photo">
            {p.thumbUrl ? (
              <button type="button" className="photo-tile" onClick={() => setSelected(p)}>
                <img src={p.thumbUrl} alt="" loading="lazy" />
              </button>
            ) : (
              <div className="photo-tile photo-placeholder">画像なし</div>
            )}
            <p className="small">{p.uploaderName ?? "（不明）"}</p>
            <p className="muted small">
              {formatTime(p.createdAt)}
              {p.status === "approved" && ` ・ ♥ ${p.favoriteCount}`}
            </p>
            <PhotoActions photo={p} onAct={act} busy={acting.has(p.photoId)} />
          </div>
        ))}
      </div>
      {cursor && (
        <button type="button" className="more" onClick={loadMore}>
          もっと見る
        </button>
      )}
      {selected && (
        <Lightbox photo={selected} onClose={() => setSelected(undefined)}>
          <PhotoActions photo={selected} onAct={act} busy={acting.has(selected.photoId)} />
        </Lightbox>
      )}
    </section>
  );
}

function PhotoActions(props: {
  photo: PhotoDto;
  onAct: (p: PhotoDto, a: "approve" | "reject" | "delete") => void;
  /** この写真の操作を送っている間 */
  busy: boolean;
}) {
  const { photo, onAct, busy } = props;
  if (photo.status === "pending") {
    return (
      <div className="actions">
        <button type="button" className="primary" onClick={() => onAct(photo, "approve")} disabled={busy}>
          承認
        </button>
        <button type="button" className="danger" onClick={() => onAct(photo, "reject")} disabled={busy}>
          却下
        </button>
      </div>
    );
  }
  if (photo.status === "approved") {
    return (
      <div className="actions">
        <button type="button" className="danger" onClick={() => onAct(photo, "delete")} disabled={busy}>
          削除
        </button>
      </div>
    );
  }
  return null;
}

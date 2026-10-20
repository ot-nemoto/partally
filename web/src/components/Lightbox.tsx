import type { PhotoDto } from "@partally/shared";
import { useEffect } from "react";

/** 写真を全画面で表示する。背景か閉じるボタンで閉じる */
export function Lightbox(props: { photo: PhotoDto; onClose: () => void; children?: React.ReactNode }) {
  const { photo, onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" onClick={onClose}>
      <img src={photo.fullUrl} alt="" onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-caption" onClick={(e) => e.stopPropagation()}>
        <span>{photo.uploaderName}</span>
        <span className="muted small">{formatTime(photo.createdAt)}</span>
        {props.children}
      </div>
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="閉じる">
        ×
      </button>
    </div>
  );
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

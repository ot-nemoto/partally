import type { PhotoDto } from "@partally/shared";
import { Modal } from "./Modal";

/** 写真を全画面で表示する。背景・閉じるボタン・Esc で閉じる */
export function Lightbox(props: { photo: PhotoDto; onClose: () => void; children?: React.ReactNode }) {
  const { photo, onClose } = props;
  return (
    <Modal className="lightbox" label="写真" onClose={onClose}>
      <img src={photo.fullUrl} alt="" />
      <div className="lightbox-caption">
        <span>{photo.uploaderName}</span>
        <span className="muted small">{formatTime(photo.createdAt)}</span>
        {props.children}
      </div>
      {/* 承認ボタンなどに最初からフォーカスが当たって誤操作しないよう、閉じるボタンにフォーカスする */}
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="閉じる" data-autofocus>
        ×
      </button>
    </Modal>
  );
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { enqueuePhoto, flushQueue, type QueueState, subscribeQueue } from "../photos/queue";
import { useParticipant } from "./ParticipantLayout";

/** 撮影・写真選択のボタンと送信状況 */
export function CaptureButtons() {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueState>({ waiting: 0, uploading: false });
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();
  const t = useT();
  const { user } = useParticipant();

  useEffect(() => subscribeQueue(setQueue), []);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    setProcessing(true);
    setError(undefined);
    try {
      for (const file of files) await enqueuePhoto(file, user.userId);
    } catch {
      setError(
        t(
          "この写真は読み込めませんでした。別の写真でお試しください。",
          "This photo couldn’t be read. Please try another one.",
        ),
      );
    } finally {
      setProcessing(false);
    }
  }

  return (
    <section className="card">
      <div className="capture-buttons">
        <button
          type="button"
          className="primary capture"
          onClick={() => cameraRef.current?.click()}
          disabled={processing}
        >
          {t("撮影する", "Take a photo")}
        </button>
        <button type="button" onClick={() => libraryRef.current?.click()} disabled={processing}>
          {t("写真を選ぶ", "Choose photos")}
        </button>
      </div>
      {/* capture 指定で端末のカメラアプリが起動する */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onChange} />
      <input ref={libraryRef} type="file" accept="image/*" multiple hidden onChange={onChange} />
      {processing && <p className="muted small">{t("写真を準備しています…", "Preparing photos…")}</p>}
      {queue.waiting > 0 && (
        <p className="muted small">
          {queue.uploading
            ? t(`送信中：${queue.waiting} 枚`, `Uploading: ${queue.waiting}`)
            : t(`送信待ち：${queue.waiting} 枚`, `Waiting to upload: ${queue.waiting}`)}
        </p>
      )}
      {error && <p className="error small">{error}</p>}
      {queue.error && (
        <div className="error small">
          <p>{t(...queue.error)}</p>
          {queue.errorDetail && (
            <p className="muted">
              {t("詳細：", "Details: ")}
              {queue.errorDetail}
            </p>
          )}
          {queue.waiting > 0 && !queue.uploading && (
            <button type="button" onClick={() => void flushQueue()}>
              {t("今すぐ再送", "Retry now")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

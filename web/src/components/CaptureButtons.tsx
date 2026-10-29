import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { enqueuePhoto, flushQueue, type QueueState, subscribeQueue } from "../photos/queue";

/** 撮影・写真選択のボタンと送信状況 */
export function CaptureButtons() {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueState>({ waiting: 0, uploading: false });
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => subscribeQueue(setQueue), []);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    setProcessing(true);
    setError(undefined);
    try {
      for (const file of files) await enqueuePhoto(file);
    } catch {
      setError("この写真は読み込めませんでした。別の写真でお試しください。");
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
          撮影する
        </button>
        <button type="button" onClick={() => libraryRef.current?.click()} disabled={processing}>
          写真を選ぶ
        </button>
      </div>
      {/* capture 指定で端末のカメラアプリが起動する */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onChange} />
      <input ref={libraryRef} type="file" accept="image/*" multiple hidden onChange={onChange} />
      {processing && <p className="muted small">写真を準備しています…</p>}
      {queue.waiting > 0 && (
        <p className="muted small">
          {queue.uploading ? "送信中" : "送信待ち"}：{queue.waiting} 枚
        </p>
      )}
      {error && <p className="error small">{error}</p>}
      {queue.error && (
        <div className="error small">
          <p>{queue.error}</p>
          {queue.errorDetail && <p className="muted">詳細：{queue.errorDetail}</p>}
          {queue.waiting > 0 && !queue.uploading && (
            <button type="button" onClick={() => void flushQueue()}>
              今すぐ再送
            </button>
          )}
        </div>
      )}
    </section>
  );
}

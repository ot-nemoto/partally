import type { PresignedPost, UploadUrlResponse } from "@partally/shared";
import { ApiError, api } from "../api";
import { processPhoto } from "./process";

/** 送信待ちの写真。通信が切れてもページを閉じても消えないよう IndexedDB に置く */
interface QueuedUpload {
  id: string;
  full: Blob;
  thumb: Blob;
  createdAt: number;
  /** 発行済みのアップロード先。再送時に使い回し、同じ写真が別の写真として二重に登録されないようにする */
  target?: UploadUrlResponse & { issuedAt: number };
  /** サーバに断られた回数（通信エラーは数えない） */
  failures: number;
}

export interface QueueState {
  /** 送信待ちの枚数（送信中を含む） */
  waiting: number;
  uploading: boolean;
  /** 直近の送信が失敗していれば、その理由 */
  error?: string;
}

const DB_NAME = "partally";
const STORE = "uploads";
const RETRY_INTERVAL_MS = 30_000;
/** 署名付き POST の有効期限（5 分）より少し短く見積もる */
const TARGET_REUSE_MS = 4 * 60 * 1000;
/** サーバにこの回数断られた写真は諦めて破棄する（後ろの写真が送れなくなるのを防ぐ） */
const MAX_FAILURES = 5;

/** S3 や API が送信を断った（通信エラーではない） */
class RejectedError extends Error {
  constructor(readonly status: number) {
    super(`送信が拒否されました（${status}）`);
  }
}

let state: QueueState = { waiting: 0, uploading: false };
const listeners = new Set<(s: QueueState) => void>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** 送信中に新しい写真が入ったら、終わったあとにもう一周する */
let rerunRequested = false;

export function subscribeQueue(listener: (s: QueueState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** 写真を縮小して送信待ちに入れ、送信を始める */
export async function enqueuePhoto(file: File): Promise<void> {
  const { full, thumb } = await processPhoto(file);
  const item: QueuedUpload = { id: newId(), full, thumb, createdAt: Date.now(), failures: 0 };
  await withStore("readwrite", (store) => store.put(item));
  await refreshCount();
  void flushQueue();
}

/**
 * 送信待ちを古い順に送る。1 枚ずつ IndexedDB から読み直すので、送信中に追加された写真も送る。
 * 失敗した写真は後回しにして次の写真へ進み、最後に少し待って再試行する。
 */
export async function flushQueue(): Promise<void> {
  if (state.uploading) {
    rerunRequested = true;
    return;
  }
  clearTimeout(retryTimer);
  setState({ uploading: true, error: undefined });
  let failed = false;
  let discarded = 0;
  try {
    const skipped = new Set<string>();
    for (;;) {
      const items = await withStore("readonly", (store) => store.getAll() as IDBRequest<QueuedUpload[]>);
      const item = items.sort((a, b) => a.createdAt - b.createdAt).find((i) => !skipped.has(i.id));
      if (!item) break;
      try {
        await upload(item);
        await withStore("readwrite", (store) => store.delete(item.id));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setState({ error: "ログインが切れています。QR コードを読み込み直してください。" });
          return;
        }
        failed = true;
        skipped.add(item.id);
        if (e instanceof RejectedError || e instanceof ApiError) {
          item.failures++;
          // 期限切れなどでアップロード先が使えなくなった可能性があるので、次回は取り直す
          item.target = undefined;
        }
        if (item.failures >= MAX_FAILURES) {
          await withStore("readwrite", (store) => store.delete(item.id));
          discarded++;
        } else {
          await withStore("readwrite", (store) => store.put(item));
        }
      }
      await refreshCount();
    }
  } finally {
    setState({ uploading: false });
  }

  if (discarded > 0) {
    setState({ error: `送信できなかった写真が ${discarded} 枚ありました。もう一度撮影・選択してください。` });
  } else if (failed) {
    setState({ error: "送信に失敗しました。電波の良い場所で自動的に再送します。" });
  }
  if (failed) retryTimer = setTimeout(() => void flushQueue(), RETRY_INTERVAL_MS);
  if (rerunRequested) {
    rerunRequested = false;
    void flushQueue();
  }
}

/** アプリ起動時に呼ぶ。前回送れなかった写真があれば送る */
export function startQueue(): void {
  void refreshCount().then(() => {
    if (state.waiting > 0) void flushQueue();
  });
  window.addEventListener("online", () => void flushQueue());
}

async function upload(item: QueuedUpload): Promise<void> {
  if (!item.target || Date.now() - item.target.issuedAt > TARGET_REUSE_MS) {
    const target = await api<UploadUrlResponse>("POST", "/photos/upload-url");
    item.target = { ...target, issuedAt: Date.now() };
    // 送信の途中で失敗しても、再送で同じ photoId に送れるよう先に保存する
    await withStore("readwrite", (store) => store.put(item));
  }
  // サムネイルを先に送る（本体の到着をきっかけにサーバが登録するため）
  await post(item.target.thumb, item.thumb);
  await post(item.target.full, item.full);
}

async function post(target: PresignedPost, blob: Blob): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append("file", blob, "photo.jpg");
  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) throw new RejectedError(res.status);
}

async function refreshCount(): Promise<void> {
  const waiting = await withStore("readonly", (store) => store.count());
  setState({ waiting });
}

function setState(patch: Partial<QueueState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** http（LAN 内の動作確認など）では crypto.randomUUID が使えないため自前で作る */
function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

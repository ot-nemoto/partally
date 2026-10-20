import type { PresignedPost, UploadUrlResponse } from "@partally/shared";
import { ApiError, api } from "../api";
import { processPhoto } from "./process";

/** 送信待ちの写真。通信が切れてもページを閉じても消えないよう IndexedDB に置く */
interface QueuedUpload {
  id: string;
  full: Blob;
  thumb: Blob;
  createdAt: number;
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

let state: QueueState = { waiting: 0, uploading: false };
const listeners = new Set<(s: QueueState) => void>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function subscribeQueue(listener: (s: QueueState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** 写真を縮小して送信待ちに入れ、送信を始める */
export async function enqueuePhoto(file: File): Promise<void> {
  const { full, thumb } = await processPhoto(file);
  await withStore("readwrite", (store) => store.put({ id: newId(), full, thumb, createdAt: Date.now() }));
  await refreshCount();
  void flushQueue();
}

/** 送信待ちを古い順に送る。失敗したら少し待って再試行する */
export async function flushQueue(): Promise<void> {
  if (state.uploading) return;
  clearTimeout(retryTimer);
  setState({ uploading: true, error: undefined });
  try {
    const items = await withStore("readonly", (store) => store.getAll() as IDBRequest<QueuedUpload[]>);
    items.sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      await upload(item);
      await withStore("readwrite", (store) => store.delete(item.id));
      await refreshCount();
    }
  } catch (e) {
    const unauthorized = e instanceof ApiError && e.status === 401;
    setState({ error: unauthorized ? "ログインが切れています。QR コードを読み込み直してください。" : "送信に失敗しました。電波の良い場所で自動的に再送します。" });
    if (!unauthorized) retryTimer = setTimeout(() => void flushQueue(), RETRY_INTERVAL_MS);
  } finally {
    setState({ uploading: false });
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
  const target = await api<UploadUrlResponse>("POST", "/photos/upload-url");
  // サムネイルを先に送る（本体の到着をきっかけにサーバが登録するため）
  await post(target.thumb, item.thumb);
  await post(target.full, item.full);
}

async function post(target: PresignedPost, blob: Blob): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append("file", blob, "photo.jpg");
  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`アップロードに失敗しました（${res.status}）`);
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

import {
  formatPositions,
  PRIZE_IMAGE_MAX_EDGE,
  type PresignedPost,
  type PrizeDto,
  type PrizeImageUploadResponse,
  type PrizeResponse,
} from "@partally/shared";
import type { PrizeArchiveItem } from "@partally/shared/prize-archive";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import { Modal } from "../../components/Modal";
import { processImage } from "../../photos/process";

/** ZIP のライブラリは使うときだけ読み込む（管理画面のほかのページを重くしない） */
const loadArchive = () => import("@partally/shared/prize-archive");

/**
 * 景品のエクスポート・インポートのボタン。エクスポートは今の景品を画像ごと ZIP にしてダウンロードし、
 * インポートは ZIP の中身を見せてから、今の景品に追加するか置き換えるかを選んで取り込む
 */
export function PrizeTransferButtons(props: { prizes: PrizeDto[] | undefined; onImported: () => void }) {
  const { prizes } = props;
  const [exporting, setExporting] = useState(false);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<PrizeArchiveItem[]>();
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportPrizes() {
    if (!prizes || prizes.length === 0) return;
    setExporting(true);
    try {
      const { buildPrizeArchive } = await loadArchive();
      const items = await Promise.all(
        prizes.map(async (p) => ({
          name: p.name,
          quantity: p.quantity,
          positions: p.positions,
          image: p.imageUrl ? await fetchBytes(p.imageUrl) : undefined,
        })),
      );
      const now = new Date();
      const zip = buildPrizeArchive(items, now.toISOString());
      download(new Blob([zip as BlobPart], { type: "application/zip" }), `partally-prizes-${dateStamp(now)}.zip`);
    } catch (e) {
      alert(`エクスポートできませんでした。${errorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setReading(true);
    try {
      const { readPrizeArchive } = await loadArchive();
      const result = readPrizeArchive(new Uint8Array(await file.arrayBuffer()));
      if (result.ok) setPreview(result.prizes);
      else alert(`このファイルは取り込めません。\n${result.error}`);
    } catch (e) {
      alert(`ファイルを読めませんでした。${errorMessage(e)}`);
    } finally {
      setReading(false);
    }
  }

  return (
    <>
      <button type="button" onClick={exportPrizes} disabled={exporting || !prizes || prizes.length === 0}>
        {exporting ? "書き出し中…" : "エクスポート"}
      </button>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={reading || !prizes}>
        {reading ? "読み込み中…" : "インポート"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {preview && prizes && (
        <ImportDialog
          items={preview}
          current={prizes}
          onClose={() => setPreview(undefined)}
          onDone={() => {
            setPreview(undefined);
            props.onImported();
          }}
        />
      )}
    </>
  );
}

type Mode = "add" | "replace";

function ImportDialog(props: {
  items: PrizeArchiveItem[];
  current: PrizeDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { items, current } = props;
  const [mode, setMode] = useState<Mode>("add");
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  // 画像のプレビュー用 URL。閉じるときに解放する
  const urls = useMemo(
    () => items.map((p) => (p.image ? URL.createObjectURL(new Blob([p.image as BlobPart])) : undefined)),
    [items],
  );
  useEffect(
    () => () => {
      for (const u of urls) if (u) URL.revokeObjectURL(u);
    },
    [urls],
  );

  /**
   * 1 件ずつ登録する。置き換えのときは、すべて登録できてから今の景品を消す
   * （途中で失敗しても、今の景品が無くならないように）
   */
  async function run() {
    if (
      mode === "replace" &&
      !confirm(`今の景品 ${current.length} 件を削除し、取り込んだ ${items.length} 件に置き換えます。よろしいですか？`)
    ) {
      return;
    }
    setRunning(true);
    setError(undefined);
    let done = 0;
    try {
      for (const item of items) {
        setProgress(`取り込み中… ${done + 1} / ${items.length}`);
        let imageId: string | undefined;
        if (item.image) {
          const jpeg = await processImage(new File([item.image as BlobPart], "prize"), PRIZE_IMAGE_MAX_EDGE);
          const res = await api<PrizeImageUploadResponse>("POST", "/admin/prizes/image-upload");
          await upload(res.upload, jpeg);
          imageId = res.imageId;
        }
        await api<PrizeResponse>("POST", "/admin/prizes", {
          name: item.name,
          quantity: item.quantity,
          positions: item.positions,
          imageId,
        });
        done++;
      }
      if (mode === "replace") {
        for (const [i, prize] of current.entries()) {
          setProgress(`今の景品を削除中… ${i + 1} / ${current.length}`);
          await api("DELETE", `/admin/prizes/${prize.prizeId}`);
        }
      }
      props.onDone();
    } catch (e) {
      const keep = mode === "replace" ? "今の景品は消していません。" : "";
      setError(
        `${done + 1} 件目（${items[done]?.name ?? ""}）で止まりました（${done} 件は取り込み済み）。${keep}${errorMessage(e)}`,
      );
      setFinished(true);
    } finally {
      setRunning(false);
      setProgress(undefined);
    }
  }

  return (
    <Modal className="dialog prize-import-dialog" label="景品のインポート" onClose={props.onClose} closable={!running}>
      <div className="card">
        <h2>景品のインポート</h2>
        <p className="small">{items.length} 件の景品を取り込みます。</p>
        <div className="table-wrap prize-import-list">
          <table className="prize-import-table">
            <thead>
              <tr>
                <th>画像</th>
                <th>名前</th>
                <th className="num">数量</th>
                <th>渡す順位</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: ファイルの中の並びで、取り込みの間は変わらない
                <tr key={i}>
                  <td>
                    {urls[i] ? (
                      <img className="prize-image small" src={urls[i]} alt="" />
                    ) : (
                      <span className="prize-image small placeholder" aria-hidden="true">
                        🎁
                      </span>
                    )}
                  </td>
                  <td>{p.name}</td>
                  <td className="num">{p.quantity}</td>
                  <td>{p.positions.length > 0 ? formatPositions(p.positions) : <span className="muted">なし</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {current.length > 0 && (
          <fieldset className="prize-import-mode" disabled={running || finished}>
            <legend>今ある景品（{current.length} 件）</legend>
            <label>
              <input type="radio" name="mode" checked={mode === "add"} onChange={() => setMode("add")} />
              残して、後ろに追加する
            </label>
            <label>
              <input type="radio" name="mode" checked={mode === "replace"} onChange={() => setMode("replace")} />
              消して、取り込んだ景品に置き換える
            </label>
            {mode === "add" && (
              <p className="muted small">同じ順位に、今の景品と取り込んだ景品の両方が割り当たることがあります。</p>
            )}
          </fieldset>
        )}
        {progress && <p className="small">{progress}</p>}
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          {finished ? (
            <button type="button" className="primary" onClick={props.onDone}>
              閉じる
            </button>
          ) : (
            <>
              <button type="button" onClick={props.onClose} disabled={running}>
                キャンセル
              </button>
              <button type="button" className="primary" onClick={run} disabled={running}>
                {running ? "取り込み中…" : "取り込む"}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像を取得できませんでした（${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function dateStamp(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export async function upload(target: PresignedPost, blob: Blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append("file", blob, "prize.jpg");
  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`画像のアップロードに失敗しました（${res.status}）`);
}

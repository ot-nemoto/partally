import { type ReactNode, useRef, useState } from "react";
import { errorMessage } from "../../../api";
import { download } from "./files";

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * エクスポート・インポートのボタン（景品・ゲーム・スケジュールで共通）。エクスポートはファイルを作ってダウンロードし、
 * インポートはファイルを読んで確かめてから、取り込みの画面（renderImport）を出す
 */
export function TransferButtons<T>(props: {
  /** エクスポートできるか（無いものは書き出さない） */
  canExport: boolean;
  /** 書き出すファイル */
  exportFile: () => Promise<{ blob: Blob; filename: string }>;
  /** インポートできるか（今の一覧を読み込むまでは取り込まない） */
  canImport: boolean;
  /** 選べるファイルの種類（input の accept） */
  accept: string;
  /** 選んだファイルを読んで確かめる */
  read: (file: File) => Promise<ReadResult<T>>;
  /** 取り込みの画面。close は取りやめ、done は取り込んだ後 */
  renderImport: (value: T, close: () => void, done: () => void) => ReactNode;
  onImported: () => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [reading, setReading] = useState(false);
  const [value, setValue] = useState<{ value: T }>();
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportNow() {
    setExporting(true);
    try {
      const { blob, filename } = await props.exportFile();
      download(blob, filename);
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
      const result = await props.read(file);
      if (result.ok) setValue({ value: result.value });
      else alert(`このファイルは取り込めません。\n${result.error}`);
    } catch (e) {
      alert(`ファイルを読めませんでした。${errorMessage(e)}`);
    } finally {
      setReading(false);
    }
  }

  return (
    <>
      <button type="button" onClick={exportNow} disabled={exporting || !props.canExport}>
        {exporting ? "書き出し中…" : "エクスポート"}
      </button>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={reading || !props.canImport}>
        {reading ? "読み込み中…" : "インポート"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={props.accept}
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {value &&
        props.renderImport(
          value.value,
          () => setValue(undefined),
          () => {
            setValue(undefined);
            props.onImported();
          },
        )}
    </>
  );
}

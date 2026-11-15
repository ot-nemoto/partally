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
  /** 読めるファイルの大きさ。読む前に確かめる（間違えて大きなファイルを選んでも、画面が固まらないように） */
  maxBytes: number;
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
    if (file.size > props.maxBytes) {
      alert(`このファイルは取り込めません。\nファイルが大きすぎます（${props.maxBytes / 1024 / 1024}MB まで）。`);
      return;
    }
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
      <button
        type="button"
        className="icon-button"
        onClick={exportNow}
        disabled={exporting || !props.canExport}
        aria-label={exporting ? "書き出し中" : "エクスポート"}
        title={exporting ? "書き出し中…" : "エクスポート（ファイルに書き出す）"}
        aria-busy={exporting}
      >
        <TransferIcon direction={exporting ? "busy" : "export"} />
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={() => fileRef.current?.click()}
        disabled={reading || !props.canImport}
        aria-label={reading ? "読み込み中" : "インポート"}
        title={reading ? "読み込み中…" : "インポート（ファイルから取り込む）"}
        aria-busy={reading}
      >
        <TransferIcon direction={reading ? "busy" : "import"} />
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

/**
 * エクスポート（トレイへ下向きの矢印）・インポート（トレイから上向きの矢印）のアイコン。色は文字の色に合わせる。
 * 書き出し中・読み込み中は回る輪にする（説明は乗せないと見えないので、進んでいることを形で見せる）
 */
function TransferIcon(props: { direction: "export" | "import" | "busy" }) {
  if (props.direction === "busy") {
    return (
      <svg
        className="spin"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-6.2-8.56" />
      </svg>
    );
  }
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
      {props.direction === "export" ? <path d="M12 4v11M7 10l5 5 5-5" /> : <path d="M12 15V4M7 9l5-5 5 5" />}
    </svg>
  );
}

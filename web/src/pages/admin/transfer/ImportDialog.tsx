import { type ReactNode, useState } from "react";
import { errorMessage } from "../../../api";
import { Modal } from "../../../components/Modal";

type Mode = "add" | "replace";

/**
 * 取り込みの画面（景品・ゲーム・スケジュールで共通）。中身を見せてから、1 件ずつ取り込む。
 * 置き換えのときは、すべて取り込めてから今のものを消す（途中で失敗しても、今のものが無くならないように）
 */
export function ImportDialog(props: {
  /** 「景品」「ゲーム」「項目」 */
  noun: string;
  /** 見出し（「景品のインポート」） */
  title: string;
  /** 取り込む件数と、それぞれの名前（止まったときの表示に使う） */
  names: string[];
  /** 中身の一覧 */
  preview: ReactNode;
  /** 今ある件数 */
  currentCount: number;
  /** 置き換えを選べるか。選べないときは後ろに追加するだけ */
  allowReplace: boolean;
  /** 取り込みの注意（いつも出す） */
  note?: ReactNode;
  /** 今あるものに追加するときの注意（今あるものがあり、追加を選んでいるときだけ出す） */
  addNote?: ReactNode;
  /** 追加・置き換えのほかに選ぶこと（スケジュールの日付など） */
  options?: (disabled: boolean) => ReactNode;
  /** i 件目を取り込む */
  importItem: (index: number) => Promise<void>;
  /** 置き換えのとき、今のものを 1 件ずつ消す */
  removeCurrent?: ((() => Promise<void>) | undefined)[];
  /** すべて取り込んだ後にすること（日付の保存など） */
  afterImport?: () => Promise<void>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { noun, names, currentCount } = props;
  const [mode, setMode] = useState<Mode>("add");
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const canReplace = props.allowReplace && currentCount > 0;

  async function run() {
    if (
      mode === "replace" &&
      !confirm(`今の${noun} ${currentCount} 件を削除し、取り込んだ ${names.length} 件に置き換えます。よろしいですか？`)
    ) {
      return;
    }
    setRunning(true);
    setError(undefined);
    let done = 0;
    let step: "import" | "remove" | "after" = "import";
    try {
      for (let i = 0; i < names.length; i++) {
        setProgress(`取り込み中… ${i + 1} / ${names.length}`);
        await props.importItem(i);
        done++;
      }
      if (mode === "replace") {
        step = "remove";
        const removers = props.removeCurrent ?? [];
        for (const [i, remove] of removers.entries()) {
          setProgress(`今の${noun}を削除中… ${i + 1} / ${removers.length}`);
          await remove?.();
        }
      }
      step = "after";
      await props.afterImport?.();
      props.onDone();
    } catch (e) {
      if (step === "import") {
        const keep = mode === "replace" ? `今の${noun}は消していません。` : "";
        setError(
          `${done + 1} 件目（${names[done] ?? ""}）で止まりました（${done} 件は取り込み済み）。${keep}${errorMessage(e)}`,
        );
      } else {
        const what = step === "remove" ? `今の${noun}の削除` : "仕上げ";
        setError(`${names.length} 件は取り込みましたが、${what}で止まりました。${errorMessage(e)}`);
      }
      setFinished(true);
    } finally {
      setRunning(false);
      setProgress(undefined);
    }
  }

  return (
    <Modal className="dialog import-dialog" label={props.title} onClose={props.onClose} closable={!running}>
      <div className="card">
        <h2>{props.title}</h2>
        <p className="small">
          {names.length} 件の{noun}を取り込みます。
        </p>
        <div className="table-wrap import-list">{props.preview}</div>
        {props.note && <p className="muted small">{props.note}</p>}
        {canReplace && (
          <fieldset className="import-mode" disabled={running || finished}>
            <legend>
              今ある{noun}（{currentCount} 件）
            </legend>
            <label>
              <input type="radio" name="mode" checked={mode === "add"} onChange={() => setMode("add")} />
              残して、後ろに追加する
            </label>
            <label>
              <input type="radio" name="mode" checked={mode === "replace"} onChange={() => setMode("replace")} />
              消して、取り込んだ{noun}に置き換える
            </label>
            {mode === "add" && props.addNote && <p className="muted small">{props.addNote}</p>}
          </fieldset>
        )}
        {props.options?.(running || finished)}
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

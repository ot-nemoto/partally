import { useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { Modal } from "./Modal";

/**
 * 画面内の確認ダイアログ。ブラウザ標準の window.confirm() の代わりに使う
 * （標準のダイアログは環境によって出ない・自動操作で承認できないことがあり、見た目もほかのモーダルと揃わないため）。
 * `if (!(await confirmDialog("…よろしいですか？"))) return;` のように使う。表示は ConfirmHost が受け持つ
 */
interface Request {
  id: number;
  message: string;
  resolve: (ok: boolean) => void;
}

let current: Request | undefined;
let nextId = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** 確認を出し、「OK」なら true、「キャンセル」・閉じたなら false で解決する。前の確認が残っていれば、それはキャンセルにする */
export function confirmDialog(message: string): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    const request: Request = {
      id: ++nextId,
      message,
      resolve: (ok) => {
        if (current === request) {
          current = undefined;
          notify();
        }
        resolve(ok);
      },
    };
    current = request;
    notify();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 確認ダイアログを表示する所。アプリに 1 つだけ置く */
export function ConfirmHost() {
  const request = useSyncExternalStore(
    subscribe,
    () => current,
    () => undefined,
  );
  const t = useT();
  if (!request) return null;
  return (
    <Modal
      key={request.id}
      className="dialog confirm-dialog"
      label={t("確認", "Confirm")}
      onClose={() => request.resolve(false)}
    >
      <div className="card">
        <p className="confirm-message">{request.message}</p>
        <div className="buttons">
          <button type="button" onClick={() => request.resolve(false)}>
            {t("キャンセル", "Cancel")}
          </button>
          <button type="button" className="primary" data-autofocus onClick={() => request.resolve(true)}>
            OK
          </button>
        </div>
      </div>
    </Modal>
  );
}

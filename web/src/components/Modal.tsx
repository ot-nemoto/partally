import { type ReactNode, useEffect, useRef } from "react";

/**
 * ブラウザ標準の <dialog> によるモーダル。Esc での閉じる操作・開いたときのフォーカス移動・
 * 背面の操作不可はブラウザに任せる（日本語入力の変換中の Esc では閉じない）。
 * 背景（::backdrop、またはダイアログ自身の余白）を押しても閉じる。
 */
export function Modal(props: {
  onClose: () => void;
  /** false の間は閉じられない（保存中など） */
  closable?: boolean;
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const { onClose, closable = true } = props;
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    // 開いたときのフォーカス先を指定したい場合は data-autofocus を付ける（無ければ最初の入力欄・ボタン）
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => dialog.close();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 背景クリックに対応するキーボード操作は Esc（dialog の cancel イベント）で提供している
    <dialog
      ref={ref}
      className={props.className}
      aria-label={props.label}
      onCancel={(e) => {
        // Esc で閉じるかどうかはこちらで決め、表示状態は React 側で管理する
        e.preventDefault();
        if (closable) onClose();
      }}
      onClick={(e) => {
        if (closable && e.target === e.currentTarget) onClose();
      }}
    >
      {props.children}
    </dialog>
  );
}

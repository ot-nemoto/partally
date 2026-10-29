import { type ReactNode, useEffect, useRef } from "react";

/**
 * 管理画面の見出しの行。英字の装飾タイトルに日本語の補足を小さく添え、children（保存ボタンなど）を右に並べる。
 * 行はスクロールしても固定したヘッダーのすぐ下に残す。高さは --admin-title-height として、その下に固定する行が使う。
 * 英字の書体（Righteous）は管理画面の共通レイアウト（AdminLayout）で読み込む
 */
export function PageTitle(props: { en: string; ja: string; className?: string; children?: ReactNode }) {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() =>
      root.style.setProperty("--admin-title-height", `${el.getBoundingClientRect().height}px`),
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--admin-title-height");
    };
  }, []);

  return (
    <div className={`title-bar${props.className ? ` ${props.className}` : ""}`} ref={barRef}>
      <h1 className="page-title">
        <span className="page-title-en gradient-title" lang="en">
          {props.en}
        </span>
        <span className="page-title-ja">{props.ja}</span>
      </h1>
      {props.children}
    </div>
  );
}

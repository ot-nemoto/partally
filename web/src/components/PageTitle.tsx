/**
 * 画面の見出し。英字の装飾タイトルに、日本語の補足を小さく添える。
 * 英字の書体（Righteous）は管理画面の共通レイアウト（AdminLayout）で読み込む
 */
export function PageTitle(props: { en: string; ja: string }) {
  return (
    <h1 className="page-title">
      <span className="page-title-en gradient-title" lang="en">
        {props.en}
      </span>
      <span className="page-title-ja">{props.ja}</span>
    </h1>
  );
}

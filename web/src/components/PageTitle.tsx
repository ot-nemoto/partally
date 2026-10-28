/** 画面の見出し。英字の装飾タイトルに、日本語の補足を小さく添える */
export function PageTitle(props: { en: string; ja: string }) {
  return (
    <h1 className="page-title">
      <span className="page-title-en">{props.en}</span>
      <span className="page-title-ja">{props.ja}</span>
    </h1>
  );
}

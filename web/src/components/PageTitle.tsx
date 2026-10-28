// 英字の書体は同じオリジンから配信する（外部への通信で画面の表示を待たせない）。
// 書体は見出しを表示したときにだけ読み込まれ、読み込むまでは system-ui で表示する
import "@fontsource/righteous/latin-400.css";

/** 画面の見出し。英字の装飾タイトルに、日本語の補足を小さく添える */
export function PageTitle(props: { en: string; ja: string }) {
  return (
    <h1 className="page-title">
      <span className="page-title-en">{props.en}</span>
      <span className="page-title-ja">{props.ja}</span>
    </h1>
  );
}

import {
  GAME_CHOICE_IMAGE_MAX_EDGE,
  type GameRequest,
  type GameResponse,
  type GamesResponse,
  gameFormatLabel,
  PRIZE_IMAGE_MAX_EDGE,
} from "@partally/shared";
import type { GameArchiveItem } from "@partally/shared/game-archive";
import { api } from "../../../api";
import { tr, useLang, useT } from "../../../i18n";
import { processImage } from "../../../photos/process";
import { FORMAT_ICON } from "../games/formats";
import { uploadGameImage } from "../prizeImage";
import { fetchImage, imageFile } from "./files";

/**
 * 今のゲームを、画像ごと書き出す形にする。作り直すのに要るものだけを入れ、状態・答え・抽選の順番・
 * 結果入力の枠に選んだ人（参加者はイベントごとに違う）は入れない。画像の取得はゲームごとに順に行う
 */
export async function exportGames(): Promise<GameArchiveItem[]> {
  const { games } = await api<GamesResponse>("GET", "/admin/games");
  const image = (url: string | undefined, name: string) => (url ? fetchImage(url, name) : undefined);
  const items: GameArchiveItem[] = [];
  for (const g of games) {
    items.push({
      format: g.format,
      name: g.name,
      description: g.description,
      image: await image(g.imageUrl, g.name),
      choices: await Promise.all(
        g.choices.map(async (ch) => ({
          text: ch.text,
          points: ch.points,
          image: await image(ch.imageUrl, tr(`${g.name}の選択肢「${ch.text}」`, `${g.name} choice “${ch.text}”`)),
        })),
      ),
      slots: g.slots.map((s) => ({ name: s.name, points: s.points })),
      ranks: g.ranks.map(({ from, to, points }) => ({ from, to, points })),
      correctNumber: g.correctNumber,
      voterPoints: g.voterPoints,
      keyword: g.keyword,
    });
  }
  return items;
}

/** 画像を端末で縮小してアップロードする（作成の画面と同じ大きさ） */
const upload = async (bytes: Uint8Array | undefined, maxEdge: number) =>
  bytes ? uploadGameImage(await processImage(imageFile(bytes), maxEdge)) : undefined;

/** ゲームを 1 件、下書きとして作る */
export async function importGame(item: GameArchiveItem): Promise<void> {
  const body: GameRequest = {
    format: item.format,
    name: item.name,
    description: item.description,
    imageId: await upload(item.image, PRIZE_IMAGE_MAX_EDGE),
    choices: await Promise.all(
      item.choices.map(async (ch) => ({
        text: ch.text,
        points: ch.points,
        imageId: await upload(ch.image, GAME_CHOICE_IMAGE_MAX_EDGE),
      })),
    ),
    slots: item.slots.map((s) => ({ ...s, userIds: [] })),
    ranks: item.ranks,
    correctNumber: item.correctNumber,
    voterPoints: item.format === "vote" ? item.voterPoints : undefined,
    keyword: item.keyword,
  };
  await api<GameResponse>("POST", "/admin/games", body);
}

/** 取り込むゲームの一覧（形式・名前・中身・画像の数） */
export function GamePreview(props: { items: GameArchiveItem[] }) {
  const t = useT();
  const lang = useLang();
  return (
    <table className="import-table">
      <thead>
        <tr>
          <th>{t("形式", "Format")}</th>
          <th>{t("名前", "Name")}</th>
          <th>{t("中身", "Contents")}</th>
          <th className="num">{t("画像", "Images")}</th>
        </tr>
      </thead>
      <tbody>
        {props.items.map((g, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ファイルの中の並びで、取り込みの間は変わらない
          <tr key={i}>
            <td className="nowrap">
              <span aria-hidden="true">{FORMAT_ICON[g.format]} </span>
              {gameFormatLabel(g.format, lang)}
            </td>
            <td>{g.name}</td>
            <td>{contentsOf(g)}</td>
            <td className="num">{(g.image ? 1 : 0) + g.choices.filter((ch) => ch.image).length}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function contentsOf(g: GameArchiveItem): string {
  switch (g.format) {
    case "quiz":
      return tr(`選択肢 ${g.choices.length}`, `${g.choices.length} choices`);
    case "result":
      return tr(`枠 ${g.slots.length}`, `${g.slots.length} slots`);
    default:
      return tr(`点数の範囲 ${g.ranks.length}`, `${g.ranks.length} points ranges`);
  }
}

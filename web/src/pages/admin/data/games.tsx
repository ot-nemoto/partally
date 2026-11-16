import {
  GAME_CHOICE_IMAGE_MAX_EDGE,
  GAME_FORMAT_LABEL,
  type GameRequest,
  type GameResponse,
  type GamesResponse,
  PRIZE_IMAGE_MAX_EDGE,
} from "@partally/shared";
import type { GameArchiveItem } from "@partally/shared/game-archive";
import { api } from "../../../api";
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
          image: await image(ch.imageUrl, `${g.name}の選択肢「${ch.text}」`),
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
  return (
    <table className="import-table">
      <thead>
        <tr>
          <th>形式</th>
          <th>名前</th>
          <th>中身</th>
          <th className="num">画像</th>
        </tr>
      </thead>
      <tbody>
        {props.items.map((g, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ファイルの中の並びで、取り込みの間は変わらない
          <tr key={i}>
            <td className="nowrap">
              <span aria-hidden="true">{FORMAT_ICON[g.format]} </span>
              {GAME_FORMAT_LABEL[g.format]}
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
      return `選択肢 ${g.choices.length}`;
    case "result":
      return `枠 ${g.slots.length}`;
    default:
      return `点数の範囲 ${g.ranks.length}`;
  }
}

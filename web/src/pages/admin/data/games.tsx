import {
  GAME_CHOICE_IMAGE_MAX_EDGE,
  type GameRequest,
  type GameResponse,
  type GamesResponse,
  gameFormatLabel,
  PRIZE_IMAGE_MAX_EDGE,
  ROUND_GAMES_MAX,
  type RoundResponse,
  type RoundsResponse,
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
  const [{ games }, { rounds }] = await Promise.all([
    api<GamesResponse>("GET", "/admin/games"),
    api<RoundsResponse>("GET", "/admin/rounds"),
  ]);
  // 入っているラウンド（名前・ラウンドの並び・中の順）も書き出す
  const roundOf = new Map(
    rounds.flatMap((r, position) => r.gameIds.map((id, index) => [id, { name: r.name, position, index }] as const)),
  );
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
      round: roundOf.get(g.gameId),
    });
  }
  return items;
}

/** 画像を端末で縮小してアップロードする（作成の画面と同じ大きさ） */
const upload = async (bytes: Uint8Array | undefined, maxEdge: number) =>
  bytes ? uploadGameImage(await processImage(imageFile(bytes), maxEdge)) : undefined;

/** ゲームを 1 件、下書きとして作る。作ったゲームの ID を返す */
export async function importGame(item: GameArchiveItem): Promise<string> {
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
  return (await api<GameResponse>("POST", "/admin/games", body)).game.gameId;
}

/**
 * 取り込んだゲームのラウンドを作り直す（ファイルのラウンドの並び・中の順のまま、今のラウンドの後ろに足す）。
 * ids は items と同じ順の、作ったゲームの ID
 */
export async function importRounds(items: GameArchiveItem[], ids: string[]): Promise<number> {
  const rounds = new Map<string, { name: string; position: number; games: { index: number; id: string }[] }>();
  items.forEach((item, i) => {
    if (!item.round || !ids[i]) return;
    const key = `${item.round.position}\u0000${item.round.name}`;
    const round = rounds.get(key) ?? { name: item.round.name, position: item.round.position, games: [] };
    round.games.push({ index: item.round.index, id: ids[i] });
    rounds.set(key, round);
  });
  const ordered = [...rounds.values()].sort((a, b) => a.position - b.position);
  for (const r of ordered) {
    const gameIds = r.games
      .sort((a, b) => a.index - b.index)
      .map((g) => g.id)
      .slice(0, ROUND_GAMES_MAX);
    await api<RoundResponse>("POST", "/admin/rounds", { name: r.name, gameIds });
  }
  return ordered.length;
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
            <td>
              {g.name}
              {g.round && (
                <span className="muted small">
                  {t(`（ラウンド「${g.round.name}」）`, ` (round “${g.round.name}”)`)}
                </span>
              )}
            </td>
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
      return tr(`選択肢 ${g.choices.length}`, `${g.choices.length} ${g.choices.length === 1 ? "choice" : "choices"}`);
    case "result":
      return tr(`枠 ${g.slots.length}`, `${g.slots.length} ${g.slots.length === 1 ? "slot" : "slots"}`);
    default:
      return tr(
        `点数の範囲 ${g.ranks.length}`,
        `${g.ranks.length} ${g.ranks.length === 1 ? "points range" : "points ranges"}`,
      );
  }
}

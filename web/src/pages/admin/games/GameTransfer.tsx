import {
  ARCHIVE_MAX_BYTES,
  GAME_CHOICE_IMAGE_MAX_EDGE,
  GAME_FORMAT_LABEL,
  type GameDto,
  type GameRequest,
  type GameResponse,
  type GamesResponse,
  PRIZE_IMAGE_MAX_EDGE,
} from "@partally/shared";
import type { GameArchiveItem } from "@partally/shared/game-archive";
import { api } from "../../../api";
import { processImage } from "../../../photos/process";
import { uploadGameImage } from "../prizeImage";
import { dateStamp, fetchImage, imageFile } from "../transfer/files";
import { ImportDialog } from "../transfer/ImportDialog";
import { TransferButtons } from "../transfer/TransferButtons";
import { FORMAT_ICON } from "./formats";

/** ZIP のライブラリは使うときだけ読み込む（管理画面のほかのページを重くしない） */
const loadArchive = () => import("@partally/shared/game-archive");

/**
 * ゲームのエクスポート・インポートのボタン。エクスポートは今のゲームを画像ごと ZIP にしてダウンロードし、
 * インポートは ZIP の中身を見せてから、作った順に下書きとして後ろに追加する（置き換えは無い。確定したゲームを消すと、
 * 入ったポイントが消えるため）
 */
export function GameTransferButtons(props: { games: GameDto[] | undefined; onImported: () => void }) {
  const { games } = props;

  async function exportFile() {
    const [{ buildGameArchive }, latest] = await Promise.all([
      loadArchive(),
      // 画像の署名付き URL には期限があるので、開いたままの一覧ではなく今の一覧から取る
      api<GamesResponse>("GET", "/admin/games"),
    ]);
    const image = (url: string | undefined, name: string) => (url ? fetchImage(url, name) : undefined);
    // 画像の取得はゲームごとに順に行う（ゲームが多くても、一度に何百も取りに行かないように）
    const items: GameArchiveItem[] = [];
    for (const g of latest.games) {
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
        // 枠に選んだ人はイベントごとに違うので入れない
        slots: g.slots.map((s) => ({ name: s.name, points: s.points })),
        ranks: g.ranks.map(({ from, to, points }) => ({ from, to, points })),
        correctNumber: g.correctNumber,
        voterPoints: g.voterPoints,
        keyword: g.keyword,
      });
    }
    const now = new Date();
    const zip = buildGameArchive(items, now.toISOString());
    return {
      blob: new Blob([zip as BlobPart], { type: "application/zip" }),
      filename: `partally-games-${dateStamp(now)}.zip`,
    };
  }

  /** 画像を端末で縮小してアップロードする（作成の画面と同じ大きさ） */
  const upload = async (bytes: Uint8Array | undefined, maxEdge: number) =>
    bytes ? uploadGameImage(await processImage(imageFile(bytes), maxEdge)) : undefined;

  return (
    <TransferButtons<GameArchiveItem[]>
      canExport={!!games && games.length > 0}
      exportFile={exportFile}
      canImport={!!games}
      accept=".zip,application/zip"
      maxBytes={ARCHIVE_MAX_BYTES}
      read={async (file) => {
        const { readGameArchive } = await loadArchive();
        const result = readGameArchive(new Uint8Array(await file.arrayBuffer()));
        return result.ok ? { ok: true, value: result.games } : result;
      }}
      renderImport={(items, close, done) => (
        <ImportDialog
          noun="ゲーム"
          title="ゲームのインポート"
          names={items.map((g) => g.name)}
          preview={<GamePreview items={items} />}
          currentCount={games?.length ?? 0}
          allowReplace={false}
          note={
            <>
              作った順に、<strong>下書き</strong>として後ろに追加します（今のゲームは消しません）。
              結果入力の枠に選ぶ人は、取り込んだ後に選んでください。
            </>
          }
          importItem={async (i) => {
            const item = items[i]!;
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
          }}
          onClose={close}
          onDone={done}
        />
      )}
      onImported={props.onImported}
    />
  );
}

/** 取り込むゲームの一覧（形式・名前・中身・画像の数） */
function GamePreview(props: { items: GameArchiveItem[] }) {
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
            <td>
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

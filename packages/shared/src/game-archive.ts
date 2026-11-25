import {
  type AddImage,
  buildArchive,
  imageCollector,
  imagePathOf,
  isRecord,
  issueText,
  readArchive,
} from "./archive.js";
import type { RankRange } from "./game-rules.js";
import { gameRequestSchema, roundRequestSchema } from "./schemas.js";
import type { GameFormat } from "./types.js";

/**
 * ゲームのエクスポート・インポートに使う ZIP。games.json（ゲームの一覧）と images/ の画像（問題・選択肢）を入れる。
 * 入れるのは作り直すのに要るものだけで、状態・答え・抽選の順番・結果入力の枠に選んだ人（参加者はイベントごとに違う）は入れない。
 * API の index からは読み込まない（ZIP のライブラリを API に含めないため）。画面から `@partally/shared/game-archive` で読み込む
 */

/** games.json の format。別のアプリの JSON や、景品の ZIP を取り違えて取り込まないための印 */
export const GAME_ARCHIVE_FORMAT = "partally-games";
export const GAME_ARCHIVE_VERSION = 1;
export const GAME_ARCHIVE_MANIFEST = "games.json";

export interface GameArchiveChoice {
  text: string;
  points: number;
  /** 画像のファイルの中身。無ければ画像なし */
  image?: Uint8Array;
}

export interface GameArchiveItem {
  format: GameFormat;
  name: string;
  description: string;
  /** 問題の画像のファイルの中身。無ければ画像なし */
  image?: Uint8Array;
  /** クイズの選択肢 */
  choices: GameArchiveChoice[];
  /** 結果入力の枠（選んだ人は入れない） */
  slots: { name: string; points: number }[];
  /** 数値予想・投票・合言葉・抽選の点数の範囲 */
  ranks: RankRange[];
  correctNumber?: number;
  voterPoints: number;
  keyword?: string;
  /** 入っていたラウンド（名前・ラウンドの並び・ラウンドの中の順）。取り込むとき、同じ名前のラウンドを作り直す */
  round?: GameArchiveRound;
}

export interface GameArchiveRound {
  name: string;
  /** ラウンドの並び（0 から） */
  position: number;
  /** ラウンドの中の順（0 から） */
  index: number;
}

export interface ManifestGame extends Omit<GameArchiveItem, "image" | "choices"> {
  /** ZIP の中の画像のパス（games.json からの相対） */
  image?: string;
  choices: (Omit<GameArchiveChoice, "image"> & { image?: string })[];
}

interface Manifest {
  format: typeof GAME_ARCHIVE_FORMAT;
  version: number;
  exportedAt: string;
  games: ManifestGame[];
}

/** ゲームの一覧を、ZIP の一覧の JSON に書く形にする（画像は問題・選択肢の順に addImage で入れる） */
export function gameManifest(games: GameArchiveItem[], addImage: AddImage): ManifestGame[] {
  return games.map(({ image, choices, ...game }) => ({
    ...game,
    image: addImage(image),
    choices: choices.map(({ image: choiceImage, ...choice }) => ({ ...choice, image: addImage(choiceImage) })),
  }));
}

/** ゲームの画像の数（問題と選択肢） */
export function gameImageCount(games: GameArchiveItem[]): number {
  return games.reduce((n, g) => n + (g.image ? 1 : 0) + g.choices.filter((ch) => ch.image).length, 0);
}

/** ゲームを ZIP にする。画像は images/01.jpg のように、問題・選択肢の順に通し番号で入れる */
export function buildGameArchive(games: GameArchiveItem[], exportedAt: string): Uint8Array {
  const { addImage, images } = imageCollector(gameImageCount(games));
  const manifest: Manifest = {
    format: GAME_ARCHIVE_FORMAT,
    version: GAME_ARCHIVE_VERSION,
    exportedAt,
    games: gameManifest(games, addImage),
  };
  return buildArchive(GAME_ARCHIVE_MANIFEST, manifest, images);
}

export type GameArchiveResult = { ok: true; games: GameArchiveItem[] } | { ok: false; error: string };

/**
 * ZIP を読み、取り込める形か確かめる。各ゲームはゲームの作成と同じ決まり（gameRequestSchema）で確かめ、
 * 1 つでも問題があれば、何も取り込まないよう全体を失敗にする
 */
export function readGameArchive(data: Uint8Array): GameArchiveResult {
  const archive = readArchive(data, GAME_ARCHIVE_MANIFEST);
  if (!archive.ok) return archive;
  return parseGameArchive(archive.manifest, archive.file);
}

/** ゲームの ZIP の一覧の JSON（games.json）を確かめる */
export function parseGameArchive(manifest: unknown, file: (path: string) => Uint8Array | undefined): GameArchiveResult {
  if (!isRecord(manifest) || manifest.format !== GAME_ARCHIVE_FORMAT) {
    return fail(`${GAME_ARCHIVE_MANIFEST} がゲームのエクスポートの形ではありません。`);
  }
  if (manifest.version !== GAME_ARCHIVE_VERSION) {
    return fail(`対応していない版の ZIP です（${String(manifest.version)}）。`);
  }
  if (!Array.isArray(manifest.games)) return fail(`${GAME_ARCHIVE_MANIFEST} にゲームの一覧（games）がありません。`);
  return parseGames(manifest.games, file);
}

/**
 * ゲームの一覧を確かめる。各ゲームはゲームの作成と同じ決まり（gameRequestSchema）で確かめ、
 * 1 つでも問題があれば、何も取り込まないよう全体を失敗にする
 */
export function parseGames(list: unknown[], file: (path: string) => Uint8Array | undefined): GameArchiveResult {
  if (list.length === 0) return fail("ゲームが 1 つも入っていません。");
  const games: GameArchiveItem[] = [];
  for (const [i, raw] of list.entries()) {
    const label = `${i + 1} 件目`;
    if (!isRecord(raw)) return fail(`${label}: ゲームの形になっていません。`);
    const rawChoices = raw.choices ?? [];
    const rawSlots = raw.slots ?? [];
    if (!Array.isArray(rawChoices) || !rawChoices.every(isRecord))
      return fail(`${label}: 選択肢の形になっていません。`);
    if (!Array.isArray(rawSlots) || !rawSlots.every(isRecord)) return fail(`${label}: 枠の形になっていません。`);
    // 画像はファイルなので ID の代わりに外して確かめる。枠の人は取り込まない
    const parsed = gameRequestSchema.safeParse({
      format: raw.format,
      name: raw.name,
      description: raw.description,
      choices: rawChoices.map((ch) => ({ text: ch.text, points: ch.points })),
      slots: rawSlots.map((s) => ({ name: s.name, points: s.points, userIds: [] })),
      ranks: raw.ranks,
      correctNumber: raw.correctNumber ?? undefined,
      voterPoints: raw.voterPoints ?? undefined,
      keyword: raw.keyword ?? undefined,
    });
    if (!parsed.success) return fail(`${label}（${String(raw.name ?? "")}）: ${issueText(parsed.error.issues)}`);
    const image = (value: unknown, where: string): Uint8Array | undefined | string => {
      const path = imagePathOf(value);
      if (path === false) return `${label}: ${where}の画像のパスが正しくありません。`;
      if (path === undefined) return undefined;
      return file(path) ?? `${label}: ${where}の画像 ${path} が ZIP の中にありません。`;
    };
    const gameImage = image(raw.image, "問題");
    if (typeof gameImage === "string") return fail(gameImage);
    const choices: GameArchiveChoice[] = [];
    for (const [j, choice] of (parsed.data.choices ?? []).entries()) {
      const choiceImage = image(rawChoices[j]!.image, `選択肢 ${j + 1} `);
      if (typeof choiceImage === "string") return fail(choiceImage);
      choices.push({ text: choice.text, points: choice.points, ...(choiceImage ? { image: choiceImage } : {}) });
    }
    // ラウンドは任意（前の版のファイルには無い）。形が合わなければ、ラウンドを付けずに取り込む
    const round = parseRound(raw.round);
    games.push({
      ...(round ? { round } : {}),
      format: parsed.data.format,
      name: parsed.data.name,
      description: parsed.data.description ?? "",
      ...(gameImage ? { image: gameImage } : {}),
      choices,
      slots: (parsed.data.slots ?? []).map(({ name, points }) => ({ name, points })),
      ranks: [...(parsed.data.ranks ?? [])].sort((a, b) => a.from - b.from),
      ...(parsed.data.correctNumber !== undefined ? { correctNumber: parsed.data.correctNumber } : {}),
      voterPoints: parsed.data.voterPoints ?? 0,
      ...(parsed.data.keyword !== undefined ? { keyword: parsed.data.keyword } : {}),
    });
  }
  return { ok: true, games };
}

function parseRound(raw: unknown): GameArchiveRound | undefined {
  if (!isRecord(raw)) return undefined;
  const name = roundRequestSchema.shape.name.safeParse(raw.name);
  const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
  if (!name.success || !isIndex(raw.position) || !isIndex(raw.index)) return undefined;
  return { name: name.data, position: raw.position, index: raw.index };
}

function fail(error: string): GameArchiveResult {
  return { ok: false, error };
}

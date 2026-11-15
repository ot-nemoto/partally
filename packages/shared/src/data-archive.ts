import { buildArchive, imageCollector, isRecord, issueText, readArchive } from "./archive.js";
import {
  GAME_ARCHIVE_MANIFEST,
  type GameArchiveItem,
  gameImageCount,
  gameManifest,
  parseGameArchive,
  parseGames,
} from "./game-archive.js";
import {
  PRIZE_ARCHIVE_MANIFEST,
  type PrizeArchiveItem,
  parsePrizeArchive,
  parsePrizes,
  prizeManifest,
} from "./prize-archive.js";
import {
  parseSchedule,
  readScheduleFile,
  SCHEDULE_FILE_MAX_BYTES,
  type ScheduleFile,
  scheduleManifest,
} from "./schedule-file.js";
import { type UpdateSettingsRequest, updateSettingsRequestSchema } from "./schemas.js";

/**
 * 管理画面の Data タブで書き出す・取り込む ZIP。景品・ゲーム・スケジュール・設定のうち選んだものを 1 つにまとめる。
 * data.json（一覧）と images/（景品・ゲームの画像。通し番号）を入れる。景品・ゲーム・スケジュールの中身は、
 * それぞれを別に書き出していたときのファイルと同じ形にし、それらのファイル（以前の ZIP・JSON）も読めるようにする。
 * API の index からは読み込まない（ZIP のライブラリを API に含めないため）。画面から `@partally/shared/data-archive` で読み込む
 */

/** data.json の format。別のアプリの JSON を取り違えて取り込まないための印 */
export const DATA_ARCHIVE_FORMAT = "partally-data";
export const DATA_ARCHIVE_VERSION = 1;
export const DATA_ARCHIVE_MANIFEST = "data.json";

/** 設定のうち、移すもの（イベントの日付はスケジュールの側で扱う） */
export type SettingsArchive = Omit<UpdateSettingsRequest, "scheduleDate">;

const settingsArchiveSchema = updateSettingsRequestSchema.omit({ scheduleDate: true });

/** まとめて書き出す・取り込むもの。入っていない種類は undefined */
export interface DataArchive {
  prizes?: PrizeArchiveItem[];
  games?: GameArchiveItem[];
  schedule?: ScheduleFile;
  settings?: SettingsArchive;
}

/** 選んだものを 1 つの ZIP にする。画像は景品・ゲーム（問題・選択肢）の順に通し番号で入れる */
export function buildDataArchive(data: DataArchive, exportedAt: string): Uint8Array {
  const count = (data.prizes ?? []).filter((p) => p.image).length + gameImageCount(data.games ?? []);
  const { addImage, images } = imageCollector(count);
  const manifest = {
    format: DATA_ARCHIVE_FORMAT,
    version: DATA_ARCHIVE_VERSION,
    exportedAt,
    ...(data.prizes ? { prizes: prizeManifest(data.prizes, addImage) } : {}),
    ...(data.games ? { games: gameManifest(data.games, addImage) } : {}),
    ...(data.schedule ? { schedule: scheduleManifest(data.schedule) } : {}),
    ...(data.settings ? { settings: data.settings } : {}),
  };
  return buildArchive(DATA_ARCHIVE_MANIFEST, manifest, images);
}

export type DataArchiveResult = { ok: true; data: DataArchive } | { ok: false; error: string };

/**
 * ファイルを読み、取り込める形か確かめる。まとめた ZIP のほか、以前の景品・ゲームの ZIP とスケジュールの JSON も読む。
 * 入っている種類ごとに、作成と同じ決まりで確かめ、1 つでも問題があれば、何も取り込まないよう全体を失敗にする
 */
export function readDataArchive(bytes: Uint8Array): DataArchiveResult {
  // ZIP は先頭が "PK"。それ以外は以前のスケジュールの JSON として読む
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    if (bytes.byteLength > SCHEDULE_FILE_MAX_BYTES) {
      return { ok: false, error: "ZIP ファイルではありません。エクスポートした ZIP を選んでください。" };
    }
    const text = new TextDecoder().decode(bytes);
    const schedule = readScheduleFile(text);
    if (schedule.ok) return { ok: true, data: { schedule: { date: schedule.date, items: schedule.items } } };
    return {
      ok: false,
      error: text.trimStart().startsWith("{")
        ? schedule.error
        : "ZIP ファイルではありません。エクスポートした ZIP を選んでください。",
    };
  }

  const archive = readArchive(bytes, [DATA_ARCHIVE_MANIFEST, PRIZE_ARCHIVE_MANIFEST, GAME_ARCHIVE_MANIFEST]);
  if (!archive.ok) return archive;
  const { manifest, file } = archive;
  if (archive.manifestName === PRIZE_ARCHIVE_MANIFEST) {
    const prizes = parsePrizeArchive(manifest, file);
    return prizes.ok ? { ok: true, data: { prizes: prizes.prizes } } : prizes;
  }
  if (archive.manifestName === GAME_ARCHIVE_MANIFEST) {
    const games = parseGameArchive(manifest, file);
    return games.ok ? { ok: true, data: { games: games.games } } : games;
  }

  if (!isRecord(manifest) || manifest.format !== DATA_ARCHIVE_FORMAT) {
    return fail(`${DATA_ARCHIVE_MANIFEST} がエクスポートの形ではありません。`);
  }
  if (manifest.version !== DATA_ARCHIVE_VERSION) {
    return fail(`対応していない版の ZIP です（${String(manifest.version)}）。`);
  }
  const data: DataArchive = {};
  if (manifest.prizes !== undefined) {
    if (!Array.isArray(manifest.prizes)) return fail("景品: 一覧（prizes）の形になっていません。");
    const prizes = parsePrizes(manifest.prizes, file);
    if (!prizes.ok) return fail(`景品: ${prizes.error}`);
    data.prizes = prizes.prizes;
  }
  if (manifest.games !== undefined) {
    if (!Array.isArray(manifest.games)) return fail("ゲーム: 一覧（games）の形になっていません。");
    const games = parseGames(manifest.games, file);
    if (!games.ok) return fail(`ゲーム: ${games.error}`);
    data.games = games.games;
  }
  if (manifest.schedule !== undefined) {
    const schedule = parseSchedule(manifest.schedule);
    if (!schedule.ok) return fail(`スケジュール: ${schedule.error}`);
    data.schedule = { date: schedule.date, items: schedule.items };
  }
  if (manifest.settings !== undefined) {
    const settings = settingsArchiveSchema.safeParse(manifest.settings);
    if (!settings.success) return fail(`設定: ${issueText(settings.error.issues)}`);
    data.settings = settings.data;
  }
  if (Object.keys(data).length === 0) return fail("景品・ゲーム・スケジュール・設定のどれも入っていません。");
  return { ok: true, data };
}

function fail(error: string): DataArchiveResult {
  return { ok: false, error };
}

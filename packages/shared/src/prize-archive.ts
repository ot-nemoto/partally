import { strFromU8, strToU8, type Unzipped, unzipSync, zipSync } from "fflate";
import { prizeRequestSchema } from "./schemas.js";

/**
 * 景品のエクスポート・インポートに使う ZIP。prizes.json（景品の一覧）と images/ の画像を入れる。
 * API の index からは読み込まない（ZIP のライブラリを API に含めないため）。画面から
 * `@partally/shared/prize-archive` で読み込む
 */

/** prizes.json の format。別のアプリの JSON を取り違えて取り込まないための印 */
export const PRIZE_ARCHIVE_FORMAT = "partally-prizes";
export const PRIZE_ARCHIVE_VERSION = 1;
export const PRIZE_ARCHIVE_MANIFEST = "prizes.json";
/** 1 回で取り込める景品の数 */
export const PRIZE_ARCHIVE_MAX_PRIZES = 100;
/** 取り込める ZIP の大きさ */
export const PRIZE_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
/** 展開した後の 1 ファイルの大きさ（画像は取り込むときに縮小し直すので、元の画像は大きくてもよい） */
export const PRIZE_ARCHIVE_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 展開した後の合計の大きさ（圧縮を悪用した巨大なファイルで画面が固まらないように） */
export const PRIZE_ARCHIVE_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface PrizeArchiveItem {
  name: string;
  quantity: number;
  /** 渡す順位（小さい順） */
  positions: number[];
  /** 画像のファイルの中身。無ければ画像なし */
  image?: Uint8Array;
}

interface ManifestPrize {
  name: string;
  quantity: number;
  positions: number[];
  /** ZIP の中の画像のパス（prizes.json からの相対） */
  image?: string;
}

interface Manifest {
  format: typeof PRIZE_ARCHIVE_FORMAT;
  version: number;
  exportedAt: string;
  prizes: ManifestPrize[];
}

/** 景品を ZIP にする。画像は images/01.jpg のように並び順の番号で入れる（JPEG は圧縮し直さない） */
export function buildPrizeArchive(prizes: PrizeArchiveItem[], exportedAt: string): Uint8Array {
  const width = Math.max(2, String(prizes.length).length);
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const manifest: Manifest = {
    format: PRIZE_ARCHIVE_FORMAT,
    version: PRIZE_ARCHIVE_VERSION,
    exportedAt,
    prizes: prizes.map((p, i) => {
      const entry: ManifestPrize = { name: p.name, quantity: p.quantity, positions: p.positions };
      if (p.image) {
        entry.image = `images/${String(i + 1).padStart(width, "0")}.jpg`;
        files[entry.image] = [p.image, { level: 0 }];
      }
      return entry;
    }),
  };
  files[PRIZE_ARCHIVE_MANIFEST] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  return zipSync(files);
}

export type PrizeArchiveResult = { ok: true; prizes: PrizeArchiveItem[] } | { ok: false; error: string };

/**
 * ZIP を読み、取り込める形か確かめる。1 つでも問題があれば、何も取り込まないよう全体を失敗にする。
 * ZIP を展開し直すと 1 つ上のフォルダに入ることがあるので、prizes.json はいちばん上か、その 1 つ下のフォルダから探す
 */
export function readPrizeArchive(data: Uint8Array): PrizeArchiveResult {
  if (data.byteLength > PRIZE_ARCHIVE_MAX_BYTES) {
    return fail(`ファイルが大きすぎます（${mib(PRIZE_ARCHIVE_MAX_BYTES)} まで）。`);
  }
  let total = 0;
  let tooLarge = false;
  let files: Unzipped;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        // macOS が付ける付属ファイルとフォルダは読まない
        if (file.name.endsWith("/") || file.name.startsWith("__MACOSX/") || /(^|\/)\._/.test(file.name)) return false;
        total += file.originalSize;
        if (file.originalSize > PRIZE_ARCHIVE_MAX_FILE_BYTES || total > PRIZE_ARCHIVE_MAX_TOTAL_BYTES) tooLarge = true;
        return !tooLarge;
      },
    });
  } catch {
    return fail("ZIP ファイルを読めませんでした。エクスポートした ZIP を選んでください。");
  }
  if (tooLarge) {
    return fail(
      `中のファイルが大きすぎます（1 つ ${mib(PRIZE_ARCHIVE_MAX_FILE_BYTES)}・合計 ${mib(PRIZE_ARCHIVE_MAX_TOTAL_BYTES)} まで）。`,
    );
  }

  const manifestPath = Object.keys(files)
    .filter((name) => name === PRIZE_ARCHIVE_MANIFEST || /^[^/]+\/prizes\.json$/.test(name))
    .sort((a, b) => a.length - b.length)[0];
  if (!manifestPath) return fail(`ZIP の中に ${PRIZE_ARCHIVE_MANIFEST} がありません。`);
  const base = manifestPath.slice(0, manifestPath.length - PRIZE_ARCHIVE_MANIFEST.length);

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(files[manifestPath]!));
  } catch {
    return fail(`${PRIZE_ARCHIVE_MANIFEST} を読めませんでした（JSON の形になっていません）。`);
  }
  if (!isRecord(manifest) || manifest.format !== PRIZE_ARCHIVE_FORMAT) {
    return fail(`${PRIZE_ARCHIVE_MANIFEST} が景品のエクスポートの形ではありません。`);
  }
  if (manifest.version !== PRIZE_ARCHIVE_VERSION) {
    return fail(`対応していない版の ZIP です（${String(manifest.version)}）。`);
  }
  if (!Array.isArray(manifest.prizes)) return fail(`${PRIZE_ARCHIVE_MANIFEST} に景品の一覧（prizes）がありません。`);
  if (manifest.prizes.length === 0) return fail("景品が 1 つも入っていません。");
  if (manifest.prizes.length > PRIZE_ARCHIVE_MAX_PRIZES) {
    return fail(`景品が多すぎます（1 回に ${PRIZE_ARCHIVE_MAX_PRIZES} 件まで）。`);
  }

  const prizes: PrizeArchiveItem[] = [];
  for (const [i, raw] of manifest.prizes.entries()) {
    const label = `${i + 1} 件目`;
    if (!isRecord(raw)) return fail(`${label}: 景品の形になっていません。`);
    const parsed = prizeRequestSchema.safeParse({ name: raw.name, quantity: raw.quantity, positions: raw.positions });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(`${label}: ${issue?.path.join(".") || "内容"} が正しくありません（${issue?.message ?? ""}）。`);
    }
    const item: PrizeArchiveItem = {
      name: parsed.data.name,
      quantity: parsed.data.quantity,
      positions: [...parsed.data.positions].sort((a, b) => a - b),
    };
    if (raw.image !== undefined && raw.image !== null && raw.image !== "") {
      if (typeof raw.image !== "string") return fail(`${label}: 画像のパスが正しくありません。`);
      const image = files[base + raw.image];
      if (!image) return fail(`${label}: 画像 ${raw.image} が ZIP の中にありません。`);
      item.image = image;
    }
    prizes.push(item);
  }
  return { ok: true, prizes };
}

function fail(error: string): PrizeArchiveResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mib(bytes: number) {
  return `${bytes / 1024 / 1024}MB`;
}

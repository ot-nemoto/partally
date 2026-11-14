import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_FILE_BYTES,
  ARCHIVE_MAX_TOTAL_BYTES,
  buildArchive,
  imageNamer,
  imagePathOf,
  isRecord,
  issueText,
  readArchive,
} from "./archive.js";
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
export const PRIZE_ARCHIVE_MAX_BYTES = ARCHIVE_MAX_BYTES;
export const PRIZE_ARCHIVE_MAX_FILE_BYTES = ARCHIVE_MAX_FILE_BYTES;
export const PRIZE_ARCHIVE_MAX_TOTAL_BYTES = ARCHIVE_MAX_TOTAL_BYTES;

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
  const imagePath = imageNamer(prizes.length);
  const images: Record<string, Uint8Array> = {};
  const manifest: Manifest = {
    format: PRIZE_ARCHIVE_FORMAT,
    version: PRIZE_ARCHIVE_VERSION,
    exportedAt,
    prizes: prizes.map((p, i) => {
      const entry: ManifestPrize = { name: p.name, quantity: p.quantity, positions: p.positions };
      if (p.image) {
        entry.image = imagePath(i + 1);
        images[entry.image] = p.image;
      }
      return entry;
    }),
  };
  return buildArchive(PRIZE_ARCHIVE_MANIFEST, manifest, images);
}

export type PrizeArchiveResult = { ok: true; prizes: PrizeArchiveItem[] } | { ok: false; error: string };

/**
 * ZIP を読み、取り込める形か確かめる。1 つでも問題があれば、何も取り込まないよう全体を失敗にする。
 * ZIP を展開し直すと 1 つ上のフォルダに入ることがあるので、prizes.json はいちばん上か、その 1 つ下のフォルダから探す
 */
export function readPrizeArchive(data: Uint8Array): PrizeArchiveResult {
  const archive = readArchive(data, PRIZE_ARCHIVE_MANIFEST);
  if (!archive.ok) return archive;
  const { manifest } = archive;
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
    if (!parsed.success) return fail(`${label}: ${issueText(parsed.error.issues)}`);
    const item: PrizeArchiveItem = {
      name: parsed.data.name,
      quantity: parsed.data.quantity,
      positions: [...parsed.data.positions].sort((a, b) => a - b),
    };
    const path = imagePathOf(raw.image);
    if (path === false) return fail(`${label}: 画像のパスが正しくありません。`);
    if (path !== undefined) {
      const image = archive.file(path);
      if (!image) return fail(`${label}: 画像 ${path} が ZIP の中にありません。`);
      item.image = image;
    }
    prizes.push(item);
  }
  return { ok: true, prizes };
}

function fail(error: string): PrizeArchiveResult {
  return { ok: false, error };
}

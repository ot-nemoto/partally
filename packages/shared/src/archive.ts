import { strFromU8, strToU8, type Unzipped, unzipSync, zipSync } from "fflate";

export { imagePathOf, isRecord, issueText } from "./archive-json.js";

/**
 * エクスポート・インポートの ZIP（景品・ゲームで共通）。いちばん上に一覧の JSON（manifest）を置き、画像を images/ に入れる。
 * API の index からは読み込まない（ZIP のライブラリを API に含めないため）。景品・ゲームの ZIP のモジュールから使う
 */

/** 取り込める ZIP の大きさ */
export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
/** 展開した後の 1 ファイルの大きさ（画像は取り込むときに縮小し直すので、元の画像は大きくてもよい） */
export const ARCHIVE_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 展開した後の合計の大きさ（圧縮を悪用した巨大なファイルで画面が固まらないように） */
export const ARCHIVE_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** 画像を images/01.jpg のように並び順の番号で入れるときの名前の作り方（番号の桁は全体の数にそろえる） */
export function imageNamer(count: number): (n: number) => string {
  const width = Math.max(2, String(count).length);
  return (n) => `images/${String(n).padStart(width, "0")}.jpg`;
}

/** 一覧の JSON と画像を ZIP にする（JPEG は圧縮し直さない） */
export function buildArchive(manifestName: string, manifest: unknown, images: Record<string, Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  for (const [path, image] of Object.entries(images)) files[path] = [image, { level: 0 }];
  files[manifestName] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  return zipSync(files);
}

export type ArchiveContents =
  | {
      ok: true;
      /** 一覧の JSON（形はまだ確かめていない） */
      manifest: unknown;
      /** 一覧の JSON からの相対パスで、ZIP の中のファイルを取る */
      file: (path: string) => Uint8Array | undefined;
    }
  | { ok: false; error: string };

/**
 * ZIP を展開し、一覧の JSON を読む。大きさを確かめ、macOS が付ける付属ファイルとフォルダは読まない。
 * ZIP を展開し直すと 1 つ上のフォルダに入ることがあるので、一覧の JSON はいちばん上か、その 1 つ下のフォルダから探す
 */
export function readArchive(data: Uint8Array, manifestName: string): ArchiveContents {
  if (data.byteLength > ARCHIVE_MAX_BYTES) {
    return { ok: false, error: `ファイルが大きすぎます（${mib(ARCHIVE_MAX_BYTES)} まで）。` };
  }
  let total = 0;
  let tooLarge = false;
  let files: Unzipped;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        if (file.name.endsWith("/") || file.name.startsWith("__MACOSX/") || /(^|\/)\._/.test(file.name)) return false;
        total += file.originalSize;
        if (file.originalSize > ARCHIVE_MAX_FILE_BYTES || total > ARCHIVE_MAX_TOTAL_BYTES) tooLarge = true;
        return !tooLarge;
      },
    });
  } catch {
    return { ok: false, error: "ZIP ファイルを読めませんでした。エクスポートした ZIP を選んでください。" };
  }
  if (tooLarge) {
    return {
      ok: false,
      error: `中のファイルが大きすぎます（1 つ ${mib(ARCHIVE_MAX_FILE_BYTES)}・合計 ${mib(ARCHIVE_MAX_TOTAL_BYTES)} まで）。`,
    };
  }

  const manifestPath = Object.keys(files)
    .filter((name) => name === manifestName || (name.endsWith(`/${manifestName}`) && name.split("/").length === 2))
    .sort((a, b) => a.length - b.length)[0];
  if (!manifestPath) return { ok: false, error: `ZIP の中に ${manifestName} がありません。` };
  const base = manifestPath.slice(0, manifestPath.length - manifestName.length);

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(files[manifestPath]!));
  } catch {
    return { ok: false, error: `${manifestName} を読めませんでした（JSON の形になっていません）。` };
  }
  return { ok: true, manifest, file: (path) => files[base + path] };
}

function mib(bytes: number) {
  return `${bytes / 1024 / 1024}MB`;
}

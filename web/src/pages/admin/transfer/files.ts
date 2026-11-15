/** エクスポート・インポートで使うファイルの部品（景品・ゲーム・スケジュールで共通） */

/** 配信中の画像を取ってくる（エクスポートで ZIP に入れる） */
export async function fetchImage(url: string, name: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`「${name}」の画像を取得できませんでした（${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * ZIP の中の画像をファイルにする。種類は先頭のバイトで見分ける（拡張子が違っていても読めるように。
 * HEIC はブラウザによっては変換が要るので、種類を付けて processImage に知らせる）
 */
export function imageFile(bytes: Uint8Array): File {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const type =
    bytes[0] === 0xff && bytes[1] === 0xd8
      ? "image/jpeg"
      : ascii(1, 4) === "PNG"
        ? "image/png"
        : ascii(0, 3) === "GIF"
          ? "image/gif"
          : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
            ? "image/webp"
            : ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1)$/.test(ascii(8, 12))
              ? "image/heic"
              : "";
  return new File([bytes as BlobPart], "image", { type });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ファイル名に付ける日時（20261224-1830） */
export function dateStamp(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

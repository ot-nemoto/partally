import { formatPositions, PRIZE_IMAGE_MAX_EDGE, type PrizeResponse, type PrizesResponse } from "@partally/shared";
import type { PrizeArchiveItem } from "@partally/shared/prize-archive";
import { useEffect, useState } from "react";
import { api } from "../../../api";
import { processImage } from "../../../photos/process";
import { uploadPrizeImage } from "../prizeImage";
import { fetchImage, imageFile } from "./files";

/** 今の景品を、画像ごと書き出す形にする（画像の署名付き URL には期限があるので、今の一覧から取る） */
export async function exportPrizes(): Promise<PrizeArchiveItem[]> {
  const { prizes } = await api<PrizesResponse>("GET", "/admin/prizes");
  const items: PrizeArchiveItem[] = [];
  for (const p of prizes) {
    items.push({
      name: p.name,
      quantity: p.quantity,
      positions: p.positions,
      image: p.imageUrl ? await fetchImage(p.imageUrl, p.name) : undefined,
    });
  }
  return items;
}

/** 景品を 1 件登録する（画像は登録の画面と同じく、端末で縮小してからアップロードする） */
export async function importPrize(item: PrizeArchiveItem): Promise<void> {
  const imageId = item.image
    ? await uploadPrizeImage(await processImage(imageFile(item.image), PRIZE_IMAGE_MAX_EDGE))
    : undefined;
  await api<PrizeResponse>("POST", "/admin/prizes", {
    name: item.name,
    quantity: item.quantity,
    positions: item.positions,
    imageId,
  });
}

/** 取り込む景品の一覧（画像・名前・数量・渡す順位） */
export function PrizePreview(props: { items: PrizeArchiveItem[] }) {
  const { items } = props;
  // 画像のプレビュー用 URL。作った effect の片付けで解放する（作り直しても、表示中の URL を解放しないように）
  const [urls, setUrls] = useState<(string | undefined)[]>([]);
  useEffect(() => {
    const created = items.map((p) => (p.image ? URL.createObjectURL(imageFile(p.image)) : undefined));
    setUrls(created);
    return () => {
      for (const u of created) if (u) URL.revokeObjectURL(u);
    };
  }, [items]);

  return (
    <table className="import-table">
      <thead>
        <tr>
          <th>画像</th>
          <th>名前</th>
          <th className="num">数量</th>
          <th>渡す順位</th>
        </tr>
      </thead>
      <tbody>
        {items.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ファイルの中の並びで、取り込みの間は変わらない
          <tr key={i}>
            <td>
              {urls[i] ? (
                <img className="prize-image small" src={urls[i]} alt="" />
              ) : (
                <span className="prize-image small placeholder" aria-hidden="true">
                  🎁
                </span>
              )}
            </td>
            <td>{p.name}</td>
            <td className="num">{p.quantity}</td>
            <td>{p.positions.length > 0 ? formatPositions(p.positions) : <span className="muted">なし</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

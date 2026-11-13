import {
  formatPositions,
  PRIZE_IMAGE_MAX_EDGE,
  type PrizeDto,
  type PrizeResponse,
  type PrizesResponse,
} from "@partally/shared";
import type { PrizeArchiveItem } from "@partally/shared/prize-archive";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { processImage } from "../../photos/process";
import { uploadPrizeImage } from "./prizeImage";
import { dateStamp, fetchImage, imageFile } from "./transfer/files";
import { ImportDialog } from "./transfer/ImportDialog";
import { TransferButtons } from "./transfer/TransferButtons";

/** ZIP のライブラリは使うときだけ読み込む（管理画面のほかのページを重くしない） */
const loadArchive = () => import("@partally/shared/prize-archive");

/**
 * 景品のエクスポート・インポートのボタン。エクスポートは今の景品を画像ごと ZIP にしてダウンロードし、
 * インポートは ZIP の中身を見せてから、今の景品に追加するか置き換えるかを選んで取り込む
 */
export function PrizeTransferButtons(props: { prizes: PrizeDto[] | undefined; onImported: () => void }) {
  const { prizes } = props;

  async function exportFile() {
    const [{ buildPrizeArchive }, latest] = await Promise.all([
      loadArchive(),
      // 画像の署名付き URL には期限があるので、開いたままの一覧ではなく今の一覧から取る
      api<PrizesResponse>("GET", "/admin/prizes"),
    ]);
    const items = await Promise.all(
      latest.prizes.map(async (p) => ({
        name: p.name,
        quantity: p.quantity,
        positions: p.positions,
        image: p.imageUrl ? await fetchImage(p.imageUrl, p.name) : undefined,
      })),
    );
    const now = new Date();
    const zip = buildPrizeArchive(items, now.toISOString());
    return {
      blob: new Blob([zip as BlobPart], { type: "application/zip" }),
      filename: `partally-prizes-${dateStamp(now)}.zip`,
    };
  }

  return (
    <TransferButtons<PrizeArchiveItem[]>
      canExport={!!prizes && prizes.length > 0}
      exportFile={exportFile}
      canImport={!!prizes}
      accept=".zip,application/zip"
      read={async (file) => {
        const { readPrizeArchive } = await loadArchive();
        const result = readPrizeArchive(new Uint8Array(await file.arrayBuffer()));
        return result.ok ? { ok: true, value: result.prizes } : result;
      }}
      renderImport={(items, close, done) => (
        <ImportDialog
          noun="景品"
          title="景品のインポート"
          names={items.map((p) => p.name)}
          preview={<PrizePreview items={items} />}
          currentCount={prizes?.length ?? 0}
          allowReplace
          addNote="同じ順位に、今の景品と取り込んだ景品の両方が割り当たることがあります。"
          importItem={async (i) => {
            const item = items[i]!;
            let imageId: string | undefined;
            if (item.image) {
              const jpeg = await processImage(imageFile(item.image), PRIZE_IMAGE_MAX_EDGE);
              imageId = await uploadPrizeImage(jpeg);
            }
            await api<PrizeResponse>("POST", "/admin/prizes", {
              name: item.name,
              quantity: item.quantity,
              positions: item.positions,
              imageId,
            });
          }}
          removeCurrent={(prizes ?? []).map((p) => () => api("DELETE", `/admin/prizes/${p.prizeId}`).then(() => {}))}
          onClose={close}
          onDone={done}
        />
      )}
      onImported={props.onImported}
    />
  );
}

/** 取り込む景品の一覧（画像・名前・数量・渡す順位） */
function PrizePreview(props: { items: PrizeArchiveItem[] }) {
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

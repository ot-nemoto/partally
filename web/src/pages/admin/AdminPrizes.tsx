import {
  formatPositions,
  PRIZE_NAME_MAX_LENGTH,
  PRIZE_QUANTITY_MAX,
  type PrizeDto,
  type PrizeResponse,
  type PrizesResponse,
  parsePositions,
  prizesByPosition,
} from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import { Modal } from "../../components/Modal";
import { NumberField } from "../../components/NumberField";
import { PageTitle } from "../../components/PageTitle";
import { PrizeChips, PrizeImage } from "../../components/PrizeChips";
import { useOnReload } from "../../hooks/useReload";
import { type ImageDraft, ImageField } from "./ImageField";
import { PrizeTransferButtons } from "./PrizeTransfer";
import { ImageUploads, uploadPrizeImage } from "./prizeImage";

/**
 * 景品の登録と、順位（上から何番目の人か）への割り当て。1 つの景品は数量の分だけ順位に割り当てられ、
 * 1 つの順位には複数の景品を割り当てられる
 */
export function AdminPrizes() {
  const [prizes, setPrizes] = useState<PrizeDto[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<PrizeDto | "new">();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPrizes((await api<PrizesResponse>("GET", "/admin/prizes")).prizes);
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useOnReload(load);

  async function remove(prize: PrizeDto) {
    if (!confirm(`「${prize.name}」を削除します。よろしいですか？`)) return;
    setBusy(true);
    try {
      await api("DELETE", `/admin/prizes/${prize.prizeId}`);
      await load();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const byPosition = prizesByPosition(prizes ?? []);

  return (
    <section className="admin-prizes">
      <PageTitle en="Prize" ja="景品">
        <div className="title-actions">
          <PrizeTransferButtons prizes={prizes} onImported={() => void load()} />
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            景品を登録
          </button>
        </div>
      </PageTitle>
      <p className="muted small">
        景品は、ランキングの上から何番目の人に渡すかで割り当てます（同じポイントのときは設定の「同じポイントのときの順位」に従います。紐づけを解除した人は数えません）。
        1 つの景品は数量の分だけ割り当てられ、同じ順位に複数の景品を割り当てることもできます。
      </p>
      {error && <p className="error">{error}</p>}
      {prizes?.length === 0 && <p className="muted">まだ景品がありません。</p>}

      {prizes && prizes.length > 0 && (
        <>
          <h2>登録した景品</h2>
          <div className="prize-grid">
            {prizes.map((p) => (
              <article key={p.prizeId} className="card prize-card">
                <PrizeImage prize={p} />
                <div className="prize-card-body">
                  <h3>{p.name}</h3>
                  <p className="small">
                    数量 {p.quantity}・割り当て {p.positions.length}
                    {p.positions.length < p.quantity && (
                      <span className="muted">（残り {p.quantity - p.positions.length}）</span>
                    )}
                  </p>
                  <p className="small">
                    {p.positions.length > 0 ? (
                      `順位: ${formatPositions(p.positions)}`
                    ) : (
                      <span className="muted">順位に割り当てていません</span>
                    )}
                  </p>
                </div>
                <div className="actions">
                  <button type="button" onClick={() => setEditing(p)} disabled={busy}>
                    編集
                  </button>
                  <button type="button" className="danger" onClick={() => remove(p)} disabled={busy}>
                    削除
                  </button>
                </div>
              </article>
            ))}
          </div>

          <h2>順位ごとの景品</h2>
          {byPosition.size === 0 ? (
            <p className="muted">まだ順位に割り当てていません。</p>
          ) : (
            <div className="table-wrap">
              <table className="prize-table">
                <thead>
                  <tr>
                    <th className="num">順位</th>
                    <th>景品</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byPosition].map(([position, list]) => (
                    <tr key={position}>
                      <td className="num">{position}</td>
                      <td>
                        <PrizeChips prizes={list} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && (
        <PrizeFormDialog
          prize={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
    </section>
  );
}

function PrizeFormDialog(props: { prize?: PrizeDto; onClose: () => void; onSaved: () => void }) {
  const { prize } = props;
  const [name, setName] = useState(prize?.name ?? "");
  const [quantity, setQuantity] = useState(prize?.quantity ?? 1);
  const [positionsText, setPositionsText] = useState(prize ? formatPositions(prize.positions) : "");
  /** 編集中の画像（保存済みの画像か、新しく選んだ縮小済みの画像。空なら画像なし） */
  const [image, setImage] = useState<ImageDraft>({ imageId: prize?.imageId, url: prize?.imageUrl });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  /** 保存し直すときに、同じ画像をアップロードし直さない */
  const [uploads] = useState(() => new ImageUploads(uploadPrizeImage));

  // 新しく選んだ画像の表示用 URL は、閉じるときにまとめて解放する
  const created = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of created.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const parsed = parsePositions(positionsText);
  const positions = "positions" in parsed ? parsed.positions : [];
  const problem =
    "error" in parsed
      ? parsed.error
      : Number.isNaN(quantity) || quantity < 1
        ? "数量は 1 以上にしてください。"
        : positions.length > quantity
          ? `割り当てた順位（${positions.length} 個）が数量（${quantity}）を超えています。`
          : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setSaving(true);
    setError(undefined);
    try {
      await uploads.save(async () => {
        const imageId = image.blob ? await uploads.idOf(image.blob) : image.imageId;
        const body = { name, quantity, positions, imageId };
        if (prize) await api<PrizeResponse>("PUT", `/admin/prizes/${prize.prizeId}`, body);
        else await api<PrizeResponse>("POST", "/admin/prizes", body);
      });
      props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      className="dialog prize-dialog"
      label={prize ? "景品の編集" : "景品を登録"}
      onClose={props.onClose}
      closable={!saving}
    >
      <form className="card" onSubmit={onSubmit}>
        <h2>{prize ? "景品の編集" : "景品を登録"}</h2>
        <label className="field">
          <span>名前</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={PRIZE_NAME_MAX_LENGTH}
            required
            data-autofocus
          />
        </label>
        <ImageField
          label="画像"
          variant="prize"
          image={image}
          onChange={(next) => {
            // 差し替え・外した、新しく選んだ画像の表示用 URL はすぐ解放する（選び直しで画像がたまらないように）
            if (image.blob && image.url) URL.revokeObjectURL(image.url);
            setImage(next);
          }}
          onPicked={(url) => created.current.push(url)}
          onProcessing={setProcessing}
          disabled={saving}
        />
        <NumberField label="数量" value={quantity} min={1} max={PRIZE_QUANTITY_MAX} onChange={setQuantity} />
        <label className="field">
          <span>渡す順位</span>
          <input
            value={positionsText}
            onChange={(e) => setPositionsText(e.target.value)}
            placeholder="例: 1, 3, 5-10"
            inputMode="text"
            autoComplete="off"
          />
          <span className="muted small">
            上から何番目の人に渡すかを、「,」区切りや「5-10」のような範囲で指定します（数量の分まで）。
            {"positions" in parsed && ` 割り当て ${positions.length} / 数量 ${Number.isNaN(quantity) ? "-" : quantity}`}
          </span>
        </label>
        {problem && <p className="error">{problem}</p>}
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose} disabled={saving}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={saving || processing || problem !== undefined}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

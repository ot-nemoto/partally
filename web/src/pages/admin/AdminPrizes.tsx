import {
  formatPositions,
  PRIZE_IMAGE_MAX_EDGE,
  PRIZE_NAME_MAX_LENGTH,
  PRIZE_QUANTITY_MAX,
  type PresignedPost,
  type PrizeDto,
  type PrizeImageUploadResponse,
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
import { processImage } from "../../photos/process";

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
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          景品を登録
        </button>
      </PageTitle>
      <p className="muted small">
        景品は、ランキングの上から何番目の人に渡すかで割り当てます（同点のときは先に登録した人を上にします。紐づけを解除した人は数えません）。
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
  /** 新しく選んだ画像（縮小済み）。undefined なら今の画像のまま、null なら画像を外す */
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 選んだ画像のプレビュー用 URL は、差し替え・閉じるときに解放する
  useEffect(() => () => (image ? URL.revokeObjectURL(image.url) : undefined), [image]);

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
  const previewUrl = image === null ? undefined : (image?.url ?? prize?.imageUrl);

  async function pick(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    setError(undefined);
    try {
      const blob = await processImage(file, PRIZE_IMAGE_MAX_EDGE);
      setImage({ blob, url: URL.createObjectURL(blob) });
    } catch {
      setError("画像を読み込めませんでした。別の画像を選んでください。");
    } finally {
      setProcessing(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setSaving(true);
    setError(undefined);
    try {
      let imageId = image === null ? undefined : prize?.imageId;
      if (image) {
        const res = await api<PrizeImageUploadResponse>("POST", "/admin/prizes/image-upload");
        await upload(res.upload, image.blob);
        imageId = res.imageId;
      }
      const body = { name, quantity, positions, imageId };
      if (prize) await api<PrizeResponse>("PUT", `/admin/prizes/${prize.prizeId}`, body);
      else await api<PrizeResponse>("POST", "/admin/prizes", body);
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
        <div className="field">
          <span>画像</span>
          <div className="prize-image-field">
            {previewUrl ? (
              <img className="prize-image" src={previewUrl} alt="選んだ画像" />
            ) : (
              <span className="prize-image placeholder" aria-hidden="true">
                🎁
              </span>
            )}
            <div className="prize-image-actions">
              <button type="button" onClick={() => fileRef.current?.click()} disabled={processing || saving}>
                {processing ? "読み込み中…" : previewUrl ? "画像を変える" : "画像を選ぶ"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,.heic,.heif"
                hidden
                onChange={(e) => {
                  void pick(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {previewUrl && (
                <button type="button" className="link" onClick={() => setImage(null)} disabled={saving}>
                  画像を外す
                </button>
              )}
            </div>
          </div>
        </div>
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

async function upload(target: PresignedPost, blob: Blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append("file", blob, "prize.jpg");
  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`画像のアップロードに失敗しました（${res.status}）`);
}

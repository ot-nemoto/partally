import {
  FAVORITE_LIMIT_MAX,
  type ModerationMode,
  POINTS_MAX,
  type Settings,
  type SettingsResponse,
} from "@partally/shared";
import { type FormEvent, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../api";

const MODERATION_OPTIONS: { value: ModerationMode; label: string; description: string }[] = [
  {
    value: "pre",
    label: "管理者が承認してから公開",
    description: "アップロードされた写真は「確認待ち」になり、承認するまで他の参加者には見えません。",
  },
  {
    value: "post",
    label: "アップロードと同時に公開",
    description: "すぐに全員へ共有されます。不適切な写真は後から削除してください。",
  },
];

export function AdminSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [saved, setSaved] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    api<SettingsResponse>("GET", "/admin/settings")
      .then((res) => {
        setSettings(res.settings);
        setSaved(res.settings);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setMessage(undefined);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setError(undefined);
    setMessage(undefined);
    try {
      const res = await api<SettingsResponse>("PUT", "/admin/settings", settings);
      setSettings(res.settings);
      setSaved(res.settings);
      setMessage("保存しました。");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const changed = JSON.stringify(settings) !== JSON.stringify(saved);
  // 数値欄が空のときは NaN が入る
  const incomplete = settings !== undefined && Object.values(settings).some((v) => Number.isNaN(v));

  return (
    <section>
      <h1>設定</h1>
      {!settings && !error && <p className="muted">読み込み中…</p>}
      {settings && (
        <form className="settings-form" onSubmit={save}>
          <div className="card settings">
            <h2>写真の公開方法</h2>
            {MODERATION_OPTIONS.map((o) => (
              <label key={o.value} className="radio">
                <input
                  type="radio"
                  name="moderation"
                  value={o.value}
                  checked={settings.moderation === o.value}
                  onChange={() => update("moderation", o.value)}
                />
                <span>
                  <strong>{o.label}</strong>
                  <span className="muted small">{o.description}</span>
                </span>
              </label>
            ))}
            <p className="muted small">これからアップロードされる写真に適用されます。</p>
          </div>

          <div className="card settings">
            <h2>ポイント</h2>
            <NumberField
              label="写真 1 枚が公開されたときのポイント"
              value={settings.uploadPoints}
              max={POINTS_MAX}
              onChange={(v) => update("uploadPoints", v)}
            />
            <NumberField
              label="お気に入りに 1 回選ばれたときのポイント"
              value={settings.favoritePoints}
              max={POINTS_MAX}
              onChange={(v) => update("favoritePoints", v)}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.showPoints}
                onChange={(e) => update("showPoints", e.target.checked)}
              />
              <span>
                <strong>参加者のホーム画面にポイントを表示する</strong>
                <span className="muted small">
                  オフにすると、参加者には自分のポイント・お気に入りに選ばれた数・写真ごとの ♥
                  の数が見えなくなります（発表まで伏せたいとき）。集計は続き、管理画面のユーザ一覧では見られます。
                </span>
              </span>
            </label>
            <p className="muted small">
              ポイントは現在の設定で毎回計算します。変更すると、これまでの分も含めて全員のポイントが変わります。
            </p>
          </div>

          <div className="card settings">
            <h2>お気に入り</h2>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.favoritesEnabled}
                onChange={(e) => update("favoritesEnabled", e.target.checked)}
              />
              <span>
                <strong>お気に入りの選択を受け付ける</strong>
                <span className="muted small">
                  オフにすると、お気に入りの追加・解除ができなくなります（締め切り）。付いたポイントは残ります。
                </span>
              </span>
            </label>
            <NumberField
              label="1 人が選べるお気に入りの数"
              value={settings.favoriteLimit}
              max={FAVORITE_LIMIT_MAX}
              onChange={(v) => update("favoriteLimit", v)}
            />
            <p className="muted small">
              減らしても選択済みのお気に入りはそのまま残り、上限を下回るまで新しく選べません。
            </p>
          </div>

          {error && <p className="error">{error}</p>}
          {incomplete && <p className="error">空欄の項目に数値を入れてください。</p>}
          {message && <p className="small">{message}</p>}
          <div className="buttons">
            <button type="submit" className="primary" disabled={!changed || incomplete}>
              保存
            </button>
          </div>
        </form>
      )}
      {!settings && error && <p className="error">{error}</p>}
    </section>
  );
}

/**
 * 0 以上の整数の入力欄。入力中は空欄にでき（このとき onChange には NaN を渡す）、
 * 先頭の 0 は取り除く（0 の後に 1 を押すと 1 になる）。全角数字は半角にし、数字以外が混ざった入力は受け付けず、上限を超えたら上限にする
 */
function NumberField(props: { label: string; value: number; max: number; onChange: (value: number) => void }) {
  const hintId = useId();
  const text = Number.isNaN(props.value) ? "" : String(props.value);
  return (
    <label className="field number-field">
      <span>{props.label}</span>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        value={text}
        onChange={(e) => {
          const digits = e.target.value.normalize("NFKC").trim();
          // 「2.5」「-3」などを数字だけ拾って別の数にしないよう、数字以外が混ざった入力は無視する
          if (!/^[0-9]*$/.test(digits)) return;
          props.onChange(digits === "" ? Number.NaN : Math.min(props.max, Number(digits)));
        }}
        aria-describedby={hintId}
        required
      />
      <span id={hintId} className="muted small">
        0〜{props.max}
      </span>
    </label>
  );
}

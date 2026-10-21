import {
  FAVORITE_LIMIT_MAX,
  type ModerationMode,
  POINTS_MAX,
  type Settings,
  type SettingsResponse,
} from "@partally/shared";
import { type FormEvent, useEffect, useState } from "react";
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
          {message && <p className="small">{message}</p>}
          <div className="buttons">
            <button type="submit" className="primary" disabled={!changed}>
              保存
            </button>
          </div>
        </form>
      )}
      {!settings && error && <p className="error">{error}</p>}
    </section>
  );
}

function NumberField(props: { label: string; value: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="field number-field">
      <span>{props.label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={props.max}
        step={1}
        value={props.value}
        onChange={(e) => props.onChange(Math.max(0, Math.min(props.max, Math.trunc(Number(e.target.value) || 0))))}
        required
      />
    </label>
  );
}

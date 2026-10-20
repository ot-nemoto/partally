import type { ModerationMode, SettingsResponse } from "@partally/shared";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api";

const OPTIONS: { value: ModerationMode; label: string; description: string }[] = [
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
  const [moderation, setModeration] = useState<ModerationMode>();
  const [saved, setSaved] = useState<ModerationMode>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    api<SettingsResponse>("GET", "/admin/settings")
      .then((res) => {
        setModeration(res.settings.moderation);
        setSaved(res.settings.moderation);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  async function save() {
    if (!moderation) return;
    setError(undefined);
    setMessage(undefined);
    try {
      const res = await api<SettingsResponse>("PUT", "/admin/settings", { moderation });
      setSaved(res.settings.moderation);
      setMessage("保存しました。これからアップロードされる写真に適用されます。");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <section>
      <h1>設定</h1>
      <div className="card settings">
        <h2>写真の公開方法</h2>
        {OPTIONS.map((o) => (
          <label key={o.value} className="radio">
            <input
              type="radio"
              name="moderation"
              value={o.value}
              checked={moderation === o.value}
              onChange={() => setModeration(o.value)}
            />
            <span>
              <strong>{o.label}</strong>
              <span className="muted small">{o.description}</span>
            </span>
          </label>
        ))}
        {error && <p className="error">{error}</p>}
        {message && <p className="small">{message}</p>}
        <div className="buttons">
          <button type="button" className="primary" onClick={save} disabled={!moderation || moderation === saved}>
            保存
          </button>
        </div>
      </div>
    </section>
  );
}

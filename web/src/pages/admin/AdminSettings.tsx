import {
  FAVORITE_LIMIT_MAX,
  type ModerationMode,
  POINTS_MAX,
  type Settings,
  type SettingsResponse,
} from "@partally/shared";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { NumberField } from "../../components/NumberField";
import { PageTitle } from "../../components/PageTitle";
import { SwitchField } from "../../components/SwitchField";

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

type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const PUBLISH_OPTIONS: {
  label: string;
  description: string;
  visible: BooleanSetting;
  hideNames: BooleanSetting;
  hidePoints: BooleanSetting;
}[] = [
  {
    label: "ランキング",
    description: "今のポイントの高い順の順位と横棒です。",
    visible: "rankingVisible",
    hideNames: "rankingHideNames",
    hidePoints: "rankingHidePoints",
  },
  {
    label: "ポイントの推移（トレンド）",
    description: "累計ポイントの推移の折れ線です（上位 10 人を色付き、ほかを灰色で表示）。",
    visible: "trendVisible",
    hideNames: "trendHideNames",
    hidePoints: "trendHidePoints",
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
      {/* 項目が多くても保存できるよう、保存ボタンはスクロールしても画面の上に残るタイトルの行に置く */}
      <PageTitle en="Setting" ja="設定" className="settings-bar">
        {settings && (
          <button type="submit" form="settings-form" className="primary" disabled={!changed || incomplete}>
            保存
          </button>
        )}
        {/* 保存の結果を読み上げるため、中身が空でも置いておく */}
        <div className="settings-status" role="status">
          {error && <p className="error">{error}</p>}
          {incomplete && <p className="error">空欄の項目に数値を入れてください。</p>}
          {message && <p className="small">{message}</p>}
        </div>
      </PageTitle>
      {!settings && !error && <p className="muted">読み込み中…</p>}
      {settings && (
        <form id="settings-form" className="settings-form" onSubmit={save}>
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
            <NumberField
              label="お気に入りを 1 枚選んだときのポイント（選んだ人に入る）"
              value={settings.favoriteGivenPoints}
              max={POINTS_MAX}
              onChange={(v) => update("favoriteGivenPoints", v)}
            />
            <SwitchField
              label="参加者のホーム画面にポイントを表示する"
              description="オフにすると、参加者には自分のポイント・お気に入りに選ばれた数・写真ごとの ♥ の数が見えなくなります（発表まで伏せたいとき）。集計は続き、管理画面のユーザ一覧では見られます。"
              checked={settings.showPoints}
              onChange={(v) => update("showPoints", v)}
            />
            <SwitchField
              label="参加者のホーム画面にクイズの点数を表示する"
              description="オフにすると、参加者には自分のクイズの点数が見えなくなります。合計のポイントにはクイズの点数も含まれます。"
              checked={settings.showQuizPoints}
              onChange={(v) => update("showQuizPoints", v)}
            />
            <p className="muted small">
              ポイントは現在の設定で毎回計算します。変更すると、これまでの分も含めて全員のポイントが変わります。
            </p>
          </div>

          <div className="card settings">
            <h2>お気に入り</h2>
            <SwitchField
              label="お気に入りの選択を受け付ける"
              description="オフにすると、お気に入りの追加・解除ができなくなります（締め切り）。付いたポイントは残ります。"
              checked={settings.favoritesEnabled}
              onChange={(v) => update("favoritesEnabled", v)}
            />
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

          <div className="card settings">
            <h2>参加者への公開</h2>
            {PUBLISH_OPTIONS.map((o) => (
              <fieldset key={o.visible} className="publish-option">
                <SwitchField
                  label={`参加者に${o.label}を見せる`}
                  description={o.description}
                  checked={settings[o.visible]}
                  onChange={(v) => update(o.visible, v)}
                />
                <div className="publish-sub">
                  <SwitchField
                    label="名前を伏せる（全員を「???」と表示）"
                    checked={settings[o.hideNames]}
                    disabled={!settings[o.visible]}
                    onChange={(v) => update(o.hideNames, v)}
                  />
                  <SwitchField
                    label="ポイントを伏せる（棒・線の形だけを見せる）"
                    checked={settings[o.hidePoints]}
                    disabled={!settings[o.visible]}
                    onChange={(v) => update(o.hidePoints, v)}
                  />
                </div>
              </fieldset>
            ))}
            <fieldset className="publish-option">
              <SwitchField
                label="参加者に景品を見せる"
                description="何位で何がもらえるかの一覧です（景品は Prize で登録）。ランキングも見せていれば、各行にその順位の景品を添えます。"
                checked={settings.prizesVisible}
                onChange={(v) => update("prizesVisible", v)}
              />
            </fieldset>
            <p className="muted small">
              参加者の画面の「イベント情報」タブに出ます。合計と順位は、写真・お気に入り・クイズのすべてのポイントで計算します。
              ホーム画面でポイントを表示しない設定でも、ここで「ポイントを伏せる」にしない限り、ポイントは見えます。
            </p>
          </div>
        </form>
      )}
    </section>
  );
}

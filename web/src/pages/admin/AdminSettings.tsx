import {
  type EventStateResponse,
  FAVORITE_LIMIT_MAX,
  type ModerationMode,
  POINTS_MAX,
  type Settings,
  type SettingsResponse,
  TIE_BREAK_LABEL,
  TIE_BREAK_LABEL_EN,
} from "@partally/shared";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { confirmDialog } from "../../components/ConfirmDialog";
import { NumberField } from "../../components/NumberField";
import { PageTitle } from "../../components/PageTitle";
import { SortableList } from "../../components/SortableList";
import { SwitchField } from "../../components/SwitchField";
import { formatRecentTime } from "../../format";
import { tr, useLang, useT } from "../../i18n";

type Text = [ja: string, en: string];

const MODERATION_OPTIONS: { value: ModerationMode; label: Text; description: Text }[] = [
  {
    value: "pre",
    label: ["管理者が承認してから公開", "Public after an admin approves"],
    description: [
      "アップロードされた写真は「確認待ち」になり、承認するまで他の参加者には見えません。",
      "Uploaded photos are “Pending” and other participants can’t see them until approved.",
    ],
  },
  {
    value: "post",
    label: ["アップロードと同時に公開", "Public as soon as uploaded"],
    description: [
      "すぐに全員へ共有されます。不適切な写真は後から削除してください。",
      "Shared with everyone right away. Delete inappropriate photos afterwards.",
    ],
  },
];

type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const PUBLISH_OPTIONS: {
  label: Text;
  description: Text;
  visible: BooleanSetting;
  hideNames: BooleanSetting;
  hidePoints: BooleanSetting;
}[] = [
  {
    label: ["ランキング", "the ranking"],
    description: ["今のポイントの高い順の順位と横棒です。", "Ranks and bars by current points."],
    visible: "rankingVisible",
    hideNames: "rankingHideNames",
    hidePoints: "rankingHidePoints",
  },
  {
    label: ["ポイントの推移（トレンド）", "the trend"],
    description: [
      "累計ポイントの推移の折れ線です（上位 10 人を色付き、ほかを灰色で表示）。",
      "Lines of total points over time (top 10 in color, others in gray).",
    ],
    visible: "trendVisible",
    hideNames: "trendHideNames",
    hidePoints: "trendHidePoints",
  },
];

export function AdminSettings() {
  const t = useT();
  const lang = useLang();
  const [settings, setSettings] = useState<Settings>();
  const [saved, setSaved] = useState<Settings>();
  const [error, setError] = useState<string>();
  /** 知らせ（日本語・英語。表示するときに言語を選ぶ） */
  const [message, setMessage] = useState<[ja: string, en: string]>();

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
      setMessage(["保存しました。", "Saved."]);
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
            {t("保存", "Save")}
          </button>
        )}
        {/* 保存の結果を読み上げるため、中身が空でも置いておく */}
        <div className="settings-status" role="status">
          {error && <p className="error">{error}</p>}
          {incomplete && (
            <p className="error">{t("空欄の項目に数値を入れてください。", "Enter numbers in the empty fields.")}</p>
          )}
          {message && <p className="small">{t(...message)}</p>}
        </div>
      </PageTitle>
      {!settings && !error && <p className="muted">{t("読み込み中…", "Loading…")}</p>}
      {settings && (
        <form id="settings-form" className="settings-form" onSubmit={save}>
          <div className="card settings">
            <h2>{t("写真の公開方法", "How photos go public")}</h2>
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
                  <strong>{t(...o.label)}</strong>
                  <span className="muted small">{t(...o.description)}</span>
                </span>
              </label>
            ))}
            <p className="muted small">
              {t("これからアップロードされる写真に適用されます。", "Applies to photos uploaded from now on.")}
            </p>
          </div>

          <div className="card settings">
            <h2>{t("ポイント", "Points")}</h2>
            <NumberField
              label={t("写真 1 枚が公開されたときのポイント", "Points per public photo")}
              value={settings.uploadPoints}
              max={POINTS_MAX}
              onChange={(v) => update("uploadPoints", v)}
            />
            <NumberField
              label={t("お気に入りに 1 回選ばれたときのポイント", "Points per favorite received")}
              value={settings.favoritePoints}
              max={POINTS_MAX}
              onChange={(v) => update("favoritePoints", v)}
            />
            <NumberField
              label={t(
                "お気に入りを 1 枚選んだときのポイント（選んだ人に入る）",
                "Points per favorite given (to the person who chose)",
              )}
              value={settings.favoriteGivenPoints}
              max={POINTS_MAX}
              onChange={(v) => update("favoriteGivenPoints", v)}
            />
            <SwitchField
              label={t("参加者のホーム画面にポイントを表示する", "Show points on participants’ home screen")}
              description={t(
                "オフにすると、参加者には自分のポイント・お気に入りに選ばれた数・写真ごとの ♥ の数が見えなくなります（発表まで伏せたいとき）。集計は続き、管理画面のユーザ一覧では見られます。",
                "When off, participants can’t see their points, favorites received or the ♥ count on photos (to keep them secret until the announcement). Counting continues, and you can see them in Users.",
              )}
              checked={settings.showPoints}
              onChange={(v) => update("showPoints", v)}
            />
            <SwitchField
              label={t("参加者のホーム画面にゲームの点数を表示する", "Show game points on participants’ home screen")}
              description={t(
                "オフにすると、参加者には自分のゲーム（クイズを含む）の点数と、点数が入ったもの（例: じゃんけん大会 優勝）が見えなくなります。合計のポイントにはゲームの点数も含まれます。",
                "When off, participants can’t see their game points (including quizzes) or what earned them (e.g. Rock-paper-scissors Winner). Total points still include game points.",
              )}
              checked={settings.showGamePoints}
              onChange={(v) => update("showGamePoints", v)}
            />
            <p className="muted small">
              {t(
                "ポイントは現在の設定で毎回計算します。変更すると、これまでの分も含めて全員のポイントが変わります。",
                "Points are always calculated with the current settings. Changing them changes everyone’s points, including past ones.",
              )}
            </p>
          </div>

          <div className="card settings">
            <h2>{t("お気に入り", "Favorites")}</h2>
            <SwitchField
              label={t("お気に入りの選択を受け付ける", "Accept favorites")}
              description={t(
                "オフにすると、お気に入りの追加・解除ができなくなります（締め切り）。付いたポイントは残ります。",
                "When off, favorites can’t be added or removed (closed). Points already given stay.",
              )}
              checked={settings.favoritesEnabled}
              onChange={(v) => update("favoritesEnabled", v)}
            />
            <NumberField
              label={t("1 人が選べるお気に入りの数", "Favorites per person")}
              value={settings.favoriteLimit}
              max={FAVORITE_LIMIT_MAX}
              onChange={(v) => update("favoriteLimit", v)}
            />
            <p className="muted small">
              {t(
                "減らしても選択済みのお気に入りはそのまま残り、上限を下回るまで新しく選べません。",
                "Lowering it keeps favorites already chosen; people can’t choose new ones until they’re below the limit.",
              )}
            </p>
          </div>

          <div className="card settings">
            <h2>{t("同じポイントのときの順位", "Ranking for equal points")}</h2>
            <p className="muted small">
              {t(
                "合計が同じ人は、上の項目から順に比べて順位を決めます（左の ⋮⋮ をドラッグするか ↑↓ で並べ替え）。ポイントの項目は多い人、登録順は先に登録した人が上です。同じなら次の項目で比べ、必ず別々の順位にします。景品もこの順位で渡します。",
                "People with the same total are compared by these items from the top (drag ⋮⋮ or use ↑↓ to reorder). For points, more is higher; for registration order, earlier is higher. If still equal, the next item is compared, so everyone gets a different rank. Prizes follow this order too.",
              )}
            </p>
            <SortableList
              items={settings.tieBreakOrder}
              label={(key) => (lang === "en" ? capitalize(TIE_BREAK_LABEL_EN[key]) : TIE_BREAK_LABEL[key])}
              onChange={(order) => update("tieBreakOrder", order)}
            />
          </div>

          <div className="card settings">
            <h2>{t("参加者への公開", "What participants can see")}</h2>
            {PUBLISH_OPTIONS.map((o) => (
              <fieldset key={o.visible} className="publish-option">
                <SwitchField
                  label={t(`参加者に${o.label[0]}を見せる`, `Show ${o.label[1]} to participants`)}
                  description={t(...o.description)}
                  checked={settings[o.visible]}
                  onChange={(v) => update(o.visible, v)}
                />
                <div className="publish-sub">
                  <SwitchField
                    label={t("名前を伏せる（全員を「???」と表示）", "Hide names (show everyone as “???”)")}
                    checked={settings[o.hideNames]}
                    disabled={!settings[o.visible]}
                    onChange={(v) => update(o.hideNames, v)}
                  />
                  <SwitchField
                    label={t(
                      "ポイントを伏せる（棒・線の形だけを見せる）",
                      "Hide points (show only the shape of bars and lines)",
                    )}
                    checked={settings[o.hidePoints]}
                    disabled={!settings[o.visible]}
                    onChange={(v) => update(o.hidePoints, v)}
                  />
                </div>
              </fieldset>
            ))}
            <fieldset className="publish-option">
              <SwitchField
                label={t("参加者に景品を見せる", "Show prizes to participants")}
                description={t(
                  "何位で何がもらえるかの一覧です（景品は Prize で登録）。ランキングも見せていれば、各行にその順位の景品を添えます。",
                  "A list of what each position gets (register prizes in Prize). If the ranking is shown too, each row shows its prize.",
                )}
                checked={settings.prizesVisible}
                onChange={(v) => update("prizesVisible", v)}
              />
            </fieldset>
            <fieldset className="publish-option">
              <SwitchField
                label={t("参加者にスケジュールを見せる", "Show the schedule to participants")}
                description={t(
                  "進行表です（Schedule で作成）。今の時間の項目に「いま」、次の項目に「つぎ」を付けて見せます。",
                  "The program (made in Schedule). The current item is marked “Now” and the next one “Next”.",
                )}
                checked={settings.scheduleVisible}
                onChange={(v) => update("scheduleVisible", v)}
              />
            </fieldset>
            <fieldset className="publish-option">
              <SwitchField
                label={t("参加者にゲームの結果を見せる", "Show game results to participants")}
                description={t(
                  "終了したゲームごとに、正解と、自分の答えと結果、優勝などに入った人を見せます（点数は見せません）。イベントを終了した後の振り返りなどに使えます。",
                  "For each ended game, shows the answer, each participant’s own answer and result, and who placed (no points). Useful for looking back after the event ends.",
                )}
                checked={settings.gameResultsVisible}
                onChange={(v) => update("gameResultsVisible", v)}
              />
            </fieldset>
            <p className="muted small">
              {t(
                "参加者の画面の「イベント情報」タブに出ます。合計と順位は、写真・お気に入り・クイズのすべてのポイントで計算します。ホーム画面でポイントを表示しない設定でも、ここで「ポイントを伏せる」にしない限り、ポイントは見えます。",
                "Shown in the “Event info” tab on participants’ screens. Totals and ranks use all points from photos, favorites and games. Even if points are hidden on the home screen, they’re visible here unless “Hide points” is on.",
              )}
            </p>
          </div>
        </form>
      )}
      <EventEndCard />
    </section>
  );
}

/**
 * イベントの終了。押した時刻より後の写真・お気に入り・ゲームはポイントに数えない（受付は続ける）。
 * 設定の保存とは別に、押したときにすぐ反映する
 */
function EventEndCard() {
  const t = useT();
  const [endedAt, setEndedAt] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<EventStateResponse>("GET", "/admin/event")
      .then((res) => setEndedAt(res.endedAt ?? null))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  async function change(action: "end" | "reopen") {
    const question =
      action === "end"
        ? tr(
            "イベントを終了します。今より後の写真・お気に入り・ゲームはポイントに数えません（受付は続きます）。ポイントに入れたいゲームは先に終了し、確認待ちの写真は先に承認してください。よろしいですか？",
            "End the event? Photos, favorites and games after now won’t count toward points (they’re still accepted). End any games and approve any pending photos you want counted first.",
          )
        : tr(
            "イベントの終了を取り消します。終了した後の写真・お気に入り・ゲームもポイントに数えます。よろしいですか？",
            "Undo ending the event? Photos, favorites and games after it ended will count toward points again.",
          );
    if (!(await confirmDialog(question))) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<EventStateResponse>("POST", `/admin/event/${action}`);
      setEndedAt(res.endedAt ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card settings event-end">
      <h2>{t("イベントの終了", "End of event")}</h2>
      {endedAt === undefined && !error && <p className="muted">{t("読み込み中…", "Loading…")}</p>}
      {endedAt === null && (
        <>
          <p className="muted small">
            {t(
              "押した時刻より後の写真の公開・お気に入り・ゲームの終了は、ポイントに数えません（ランキング・推移・景品の順位も止まります）。写真のアップロードやお気に入り、ゲームの回答の受付は続きます。参加者の画面には「イベントは終了しました」と出ます。",
              "Photos published, favorites chosen and games ended after you press this don’t count toward points (the ranking, trend and prize positions stop too). Uploads, favorites and game answers are still accepted. Participants see “The event has ended”.",
            )}
          </p>
          <button type="button" className="danger" onClick={() => change("end")} disabled={busy}>
            {t("イベントを終了する", "End the event")}
          </button>
        </>
      )}
      {endedAt && (
        <>
          <p>
            <strong>{t(`${formatRecentTime(endedAt)} に終了しました`, `Ended at ${formatRecentTime(endedAt)}`)}</strong>
          </p>
          <p className="muted small">
            {t(
              "この時刻より後の出来事はポイントに数えていません。取り消すと、終了した後の分も数えます。",
              "Anything after this time isn’t counted. Undoing counts it again.",
            )}
          </p>
          <button type="button" onClick={() => change("reopen")} disabled={busy}>
            {t("終了を取り消す", "Undo end")}
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

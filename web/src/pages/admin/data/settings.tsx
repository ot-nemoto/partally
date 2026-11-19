import { type Settings, type SettingsResponse, TIE_BREAK_LABEL, TIE_BREAK_LABEL_EN } from "@partally/shared";
import type { SettingsArchive } from "@partally/shared/data-archive";
import { api } from "../../../api";
import { useLang, useT } from "../../../i18n";

/** 今の設定を書き出す形にする（イベントの日付はスケジュールの側で扱う） */
export async function exportSettings(): Promise<SettingsArchive> {
  const { settings } = await api<SettingsResponse>("GET", "/admin/settings");
  const { scheduleDate: _date, ...rest } = settings;
  return rest;
}

/**
 * 設定を保存する。settings を渡すと取り込んだ設定に置き換え、scheduleDate を渡すとイベントの日付を変える
 * （どちらも、今の設定に重ねて保存する。渡さなかったものは今のまま）
 */
export async function saveSettings(changes: { settings?: SettingsArchive; scheduleDate?: string }): Promise<void> {
  const { settings } = await api<SettingsResponse>("GET", "/admin/settings");
  const next: Settings = {
    ...settings,
    ...changes.settings,
    scheduleDate: changes.scheduleDate ?? settings.scheduleDate,
  };
  await api<SettingsResponse>("PUT", "/admin/settings", next);
}

/** 取り込む設定の中身（Setting 画面の見出しの順） */
export function SettingsPreview(props: { settings: SettingsArchive }) {
  const s = props.settings;
  const t = useT();
  const lang = useLang();
  const show = (v: boolean | undefined) => (v ? t("見せる", "shown") : t("見せない", "hidden"));
  const tieBreak = lang === "en" ? TIE_BREAK_LABEL_EN : TIE_BREAK_LABEL;
  const rows: [string, string][] = [
    [
      t("写真の公開方法", "How photos go public"),
      s.moderation === "pre"
        ? t("管理者が承認してから公開", "After an admin approves")
        : t("アップロードと同時に公開", "As soon as uploaded"),
    ],
    [
      t("ポイント", "Points"),
      t(
        `写真 1 枚 ${s.uploadPoints}・選ばれた ${s.favoritePoints}・選んだ ${s.favoriteGivenPoints ?? "-"}`,
        `Photo ${s.uploadPoints} · favorite received ${s.favoritePoints} · favorite given ${s.favoriteGivenPoints ?? "-"}`,
      ),
    ],
    [
      t("ホーム画面", "Home screen"),
      t(
        `ポイントを${s.showPoints === false ? "見せない" : "見せる"}・ゲームの点数を${s.showGamePoints === false ? "見せない" : "見せる"}`,
        `Points ${show(s.showPoints !== false)} · game points ${show(s.showGamePoints !== false)}`,
      ),
    ],
    [
      t("お気に入り", "Favorites"),
      t(
        `${s.favoritesEnabled ? "受け付ける" : "受け付けない"}・1 人 ${s.favoriteLimit} 枚まで`,
        `${s.favoritesEnabled ? "Open" : "Closed"} · up to ${s.favoriteLimit} per person`,
      ),
    ],
    [
      t("同じポイントのときの順位", "Ranking for equal points"),
      s.tieBreakOrder?.map((k) => tieBreak[k]).join(" → ") ?? "-",
    ],
    [
      t("参加者への公開", "What participants can see"),
      t(
        `ランキング ${show(s.rankingVisible)}・推移 ${show(s.trendVisible)}・景品 ${show(s.prizesVisible)}・スケジュール ${show(s.scheduleVisible)}・ゲームの結果 ${show(s.gameResultsVisible)}`,
        `Ranking ${show(s.rankingVisible)} · trend ${show(s.trendVisible)} · prizes ${show(s.prizesVisible)} · schedule ${show(s.scheduleVisible)} · game results ${show(s.gameResultsVisible)}`,
      ),
    ],
  ];
  return (
    <table className="import-table">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row" className="nowrap">
              {label}
            </th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

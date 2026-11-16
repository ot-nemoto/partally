import { type Settings, type SettingsResponse, TIE_BREAK_LABEL } from "@partally/shared";
import type { SettingsArchive } from "@partally/shared/data-archive";
import { api } from "../../../api";

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

const onOff = (v: boolean | undefined) => (v ? "見せる" : "見せない");

/** 取り込む設定の中身（Setting 画面の見出しの順） */
export function SettingsPreview(props: { settings: SettingsArchive }) {
  const s = props.settings;
  const rows: [string, string][] = [
    ["写真の公開方法", s.moderation === "pre" ? "管理者が承認してから公開" : "アップロードと同時に公開"],
    ["ポイント", `写真 1 枚 ${s.uploadPoints}・選ばれた ${s.favoritePoints}・選んだ ${s.favoriteGivenPoints ?? "-"}`],
    [
      "ホーム画面",
      `ポイントを${s.showPoints === false ? "見せない" : "見せる"}・ゲームの点数を${s.showGamePoints === false ? "見せない" : "見せる"}`,
    ],
    ["お気に入り", `${s.favoritesEnabled ? "受け付ける" : "受け付けない"}・1 人 ${s.favoriteLimit} 枚まで`],
    ["同じポイントのときの順位", s.tieBreakOrder?.map((k) => TIE_BREAK_LABEL[k]).join(" → ") ?? "-"],
    [
      "参加者への公開",
      `ランキング ${onOff(s.rankingVisible)}・推移 ${onOff(s.trendVisible)}・景品 ${onOff(s.prizesVisible)}・スケジュール ${onOff(s.scheduleVisible)}`,
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

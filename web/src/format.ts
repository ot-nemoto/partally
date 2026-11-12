/** 画面に出す時刻の書き方 */

/** 「11/12 14:05」の形（月/日 時:分） */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 今日なら時刻だけ（「14:05」）、別の日（リハーサルなど）なら日付も付ける（「11/12 14:05」） */
export function formatRecentTime(iso: string): string {
  const d = new Date(iso);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

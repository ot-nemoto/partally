import { type AccountsResponse, DEVICE_ACCOUNTS_MAX, type UserResponse } from "@partally/shared";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useT } from "../i18n";

/**
 * この端末で覚えている参加者の切り替え（スマホを持っていない子どもの分を、親の端末で操作するときなど）。
 * 参加者を足すときは、その人の QR コードをこの端末で読み込む（一度ログインした人には、暗証番号なしで切り替えられる）
 */
export function AccountSwitcher() {
  const t = useT();
  const [data, setData] = useState<AccountsResponse>();
  const [error, setError] = useState<string>();
  const [switching, setSwitching] = useState<string>();

  useEffect(() => {
    api<AccountsResponse>("GET", "/accounts")
      .then(setData)
      .catch(() => setData(undefined));
  }, []);

  async function switchTo(userId: string) {
    setSwitching(userId);
    setError(undefined);
    try {
      await api<UserResponse>("POST", "/accounts/switch", { userId });
      // 表示中の情報（ポイント・ゲーム・写真）をすべてその人のものにするため、ホームを開き直す
      window.location.assign("/");
    } catch (e) {
      setError(errorMessage(e));
      setSwitching(undefined);
    }
  }

  const hint = t(
    `スマホを持っていない人（お子さんなど）の分も、この端末で使えます。その人の QR コードを、この端末のカメラで読み込んでください（${DEVICE_ACCOUNTS_MAX} 人まで）。一度読み込んだ人には、ここから切り替えられます。`,
    `You can also use this phone for someone without one (such as a child). Scan their QR code with this phone's camera (up to ${DEVICE_ACCOUNTS_MAX} people). After that, you can switch to them here.`,
  );

  if (!data || data.accounts.length <= 1) {
    return (
      <details className="card account-hint">
        <summary>{t("ほかの人の分もこの端末で使う", "Use this phone for someone else too")}</summary>
        <p className="muted small">{hint}</p>
      </details>
    );
  }

  return (
    <section className="card accounts" aria-label={t("この端末の参加者", "People on this phone")}>
      <h2 className="accounts-title">{t("この端末の参加者", "People on this phone")}</h2>
      <ul className="account-list">
        {data.accounts.map((a) => (
          <li key={a.userId} className={a.userId === data.current ? "current" : undefined}>
            <span className="account-name">
              <span className="account-epithet">〈{a.epithet}〉</span>
              {a.name}
            </span>
            {a.userId === data.current ? (
              <span className="account-current">{t("使用中", "Current")}</span>
            ) : (
              <button type="button" onClick={() => void switchTo(a.userId)} disabled={switching !== undefined}>
                {switching === a.userId ? t("切り替え中…", "Switching…") : t("切り替える", "Switch")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">{hint}</p>
    </section>
  );
}

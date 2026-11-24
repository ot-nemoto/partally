import type { AccountsResponse, UserResponse } from "@partally/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "../api";
import { useT } from "../i18n";

/**
 * この端末で覚えている参加者の切り替え（言語の切り替えと同じ色の丸いボタンに、名前を並べる）。
 * 2 人以上覚えているときだけ出す。押すとその人に切り替えて、今の画面を開き直す
 */
export function UserSwitch() {
  const t = useT();
  const [data, setData] = useState<AccountsResponse>();
  const [switching, setSwitching] = useState(false);

  /** 一覧を読む（サーバは、紐づけを解除された人などを外して返す） */
  const load = useCallback(() => {
    api<AccountsResponse>("GET", "/accounts")
      .then(setData)
      .catch(() => setData(undefined));
  }, []);
  useEffect(load, [load]);

  if (!data || data.accounts.length < 2) return null;

  async function switchTo(userId: string) {
    if (userId === data?.current || switching) return;
    setSwitching(true);
    try {
      await api<UserResponse>("POST", "/accounts/switch", { userId });
      // 表示中の情報（ポイント・ゲーム・写真）をすべてその人のものにするため、今の画面を開き直す
      window.location.assign(window.location.pathname);
    } catch (e) {
      setSwitching(false);
      alert(
        e instanceof ApiError && e.status === 404
          ? t(
              "この人は、この端末では使えなくなりました（幹事が紐づけを外したなど）。",
              "This person can no longer be used on this phone (for example, the organizers unlinked them).",
            )
          : errorMessage(e),
      );
      // その人が使えなくなっていた（紐づけ解除など）ときに、ボタンを残さないよう一覧を読み直す
      load();
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: ボタンのまとまりなので fieldset ではなく group にする（言語の切り替えと同じ）
    <div className="user-switch" role="group" aria-label={t("参加者の切り替え", "Switch person")}>
      {data.accounts.map((a) => (
        <button
          key={a.userId}
          type="button"
          aria-pressed={a.userId === data.current}
          title={`〈${a.epithet}〉${a.name}`}
          disabled={switching}
          onClick={() => void switchTo(a.userId)}
        >
          <span className="user-switch-name">{a.name}</span>
        </button>
      ))}
    </div>
  );
}

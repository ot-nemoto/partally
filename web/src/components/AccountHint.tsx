import { DEVICE_ACCOUNTS_MAX } from "@partally/shared";
import { useT } from "../i18n";

/**
 * この端末でほかの人の分も使う方法の案内（スマホを持っていない子どもの分を、親の端末で操作するときなど）。
 * 切り替えは画面の上の名前のボタン（UserSwitch）で行う
 */
export function AccountHint() {
  const t = useT();
  return (
    <details className="card account-hint">
      <summary>{t("ほかの人の分もこの端末で使う", "Use this phone for someone else too")}</summary>
      <p className="muted small">
        {t(
          `スマホを持っていない人（お子さんなど）の分も、この端末で使えます。その人の QR コードを、この端末のカメラで読み込んでください（${DEVICE_ACCOUNTS_MAX} 人まで）。一度読み込んだ人には、画面の上の名前を押して切り替えられます。`,
          `You can also use this phone for someone without one (such as a child). Scan their QR code with this phone's camera (up to ${DEVICE_ACCOUNTS_MAX} people). After that, tap their name at the top of the screen to switch.`,
        )}
      </p>
    </details>
  );
}

import type { TokenDto, TokensResponse } from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api";
import { PageTitle } from "../../components/PageTitle";
import { formatDateTime } from "../../format";
import { useOnReload } from "../../hooks/useReload";
import { useT } from "../../i18n";

export function AdminTokens() {
  const t = useT();
  const [tokens, setTokens] = useState<TokenDto[]>();
  const [count, setCount] = useState(10);
  const [error, setError] = useState<string>();
  const [issuing, setIssuing] = useState(false);

  const load = useCallback(() => {
    api<TokensResponse>("GET", "/admin/tokens")
      .then((res) => {
        setTokens(res.tokens);
        setError(undefined);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);
  useOnReload(load);

  async function issue(e: FormEvent) {
    e.preventDefault();
    if (!confirm(t(`QR コードを ${count} 件発行します。よろしいですか？`, `Issue ${count} QR codes?`))) return;
    setIssuing(true);
    try {
      await api("POST", "/admin/tokens", { count });
      load();
    } catch (err) {
      setError(errorMessage(err));
      // 発行はタイトルの行から下までスクロールした所でも押せるので、エラーが見えるよう画面の上へ戻す
      window.scrollTo({ top: 0 });
    } finally {
      setIssuing(false);
    }
  }

  const bound = tokens?.filter((t) => t.status === "bound").length ?? 0;

  return (
    <section>
      <PageTitle en="QR" ja={t("QR コード管理", "QR codes")}>
        <form className="inline-form title-actions" onSubmit={issue}>
          <label>
            {t("発行数", "Count")}
            <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
          <button type="submit" className="primary" disabled={issuing}>
            {t("発行", "Issue")}
          </button>
          <Link to="/admin/tokens/print?filter=unbound" target="_blank" className="button">
            {t("未使用分を印刷", "Print unused")}
          </Link>
          <Link to="/admin/tokens/print" target="_blank" className="button">
            {t("全件を印刷", "Print all")}
          </Link>
        </form>
      </PageTitle>
      {error && <p className="error">{error}</p>}
      {tokens && (
        <p className="muted">
          {t(
            `全 ${tokens.length} 件 / 登録済み ${bound} 件 / 未使用 ${tokens.length - bound} 件`,
            `${tokens.length} total / ${bound} registered / ${tokens.length - bound} unused`,
          )}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("番号", "No.")}</th>
              <th>{t("状態", "Status")}</th>
              <th>{t("登録者", "Registered by")}</th>
              <th>{t("登録日時", "Registered at")}</th>
            </tr>
          </thead>
          <tbody>
            {tokens?.map((tk) => (
              <tr key={tk.token}>
                <td>{tk.label}</td>
                <td>{tk.status === "bound" ? t("登録済み", "Registered") : t("未使用", "Unused")}</td>
                <td>{tk.displayName ?? "-"}</td>
                <td>{tk.boundAt ? formatDateTime(tk.boundAt) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

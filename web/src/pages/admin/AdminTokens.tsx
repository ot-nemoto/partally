import type { TokenDto, TokensResponse } from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api";
import { PageTitle } from "../../components/PageTitle";
import { useOnReload } from "../../hooks/useReload";

export function AdminTokens() {
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
    if (!confirm(`QR コードを ${count} 件発行します。よろしいですか？`)) return;
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
      <PageTitle en="QR" ja="QR コード管理">
        <form className="inline-form title-actions" onSubmit={issue}>
          <label>
            発行数
            <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
          <button type="submit" className="primary" disabled={issuing}>
            発行
          </button>
          <Link to="/admin/tokens/print?filter=unbound" target="_blank" className="button">
            未使用分を印刷
          </Link>
          <Link to="/admin/tokens/print" target="_blank" className="button">
            全件を印刷
          </Link>
        </form>
      </PageTitle>
      {error && <p className="error">{error}</p>}
      {tokens && (
        <p className="muted">
          全 {tokens.length} 件 / 登録済み {bound} 件 / 未使用 {tokens.length - bound} 件
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>番号</th>
              <th>状態</th>
              <th>登録者</th>
              <th>登録日時</th>
            </tr>
          </thead>
          <tbody>
            {tokens?.map((t) => (
              <tr key={t.token}>
                <td>{t.label}</td>
                <td>{t.status === "bound" ? "登録済み" : "未使用"}</td>
                <td>{t.displayName ?? "-"}</td>
                <td>{t.boundAt ? new Date(t.boundAt).toLocaleString("ja-JP") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

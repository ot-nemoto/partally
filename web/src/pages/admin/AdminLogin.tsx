import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api, errorMessage } from "../../api";

export function AdminLogin() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await api("POST", "/admin/login", { password });
      navigate("/admin/users", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "パスワードが違います。" : errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page">
      <form className="card" onSubmit={onSubmit}>
        <h1>管理者ログイン</h1>
        <label className="field">
          <span>パスワード</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={submitting}>
          ログイン
        </button>
      </form>
    </main>
  );
}

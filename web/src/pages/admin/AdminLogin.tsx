// タイトルに管理画面の見出しと同じ英字の書体を使う（ログイン前は管理画面の共通レイアウトを通らないため、ここでも読み込む）
import "@fontsource/righteous/latin-400.css";
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
      <form className="card admin-login" onSubmit={onSubmit} aria-label="管理者ログイン">
        <h1 className="guest-title admin-login-title">
          <span className="gradient-title" lang="en">
            partally
          </span>
          <span className="admin-login-sub gradient-title" lang="en">
            admin
          </span>
        </h1>
        <p className="muted small admin-login-note">管理者のパスワードを入れてください。</p>
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

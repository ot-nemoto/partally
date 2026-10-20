import type { QrLoginResponse, RegisterResponse, UserDto } from "@partally/shared";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorMessage } from "../api";

type State =
  | { kind: "loading" }
  | { kind: "register" }
  | { kind: "registered"; user: UserDto }
  | { kind: "error"; message: string };

export function QrLanding() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    api<QrLoginResponse>("POST", "/auth/qr", { token })
      .then((res) => {
        if (cancelled) return;
        if (res.status === "bound") navigate("/", { replace: true });
        else setState({ kind: "register" });
      })
      .catch((e) => !cancelled && setState({ kind: "error", message: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(undefined);
    try {
      const res = await api<RegisterResponse>("POST", "/auth/register", { token, name });
      setState({ kind: "registered", user: res.user });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page">
      <InAppBrowserNotice />
      {state.kind === "loading" && <p className="muted">読み込み中…</p>}

      {state.kind === "error" && <p className="error">{state.message}</p>}

      {state.kind === "register" && (
        <form className="card" onSubmit={onSubmit}>
          <h1>ようこそ！</h1>
          <p>お名前を入力してください。あなただけの「二つ名」が授けられます。</p>
          <label className="field">
            <span>お名前</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="例：田中"
              autoComplete="name"
              required
            />
          </label>
          {formError && <p className="error">{formError}</p>}
          <button type="submit" className="primary" disabled={submitting || name.trim() === ""}>
            {submitting ? "登録中…" : "登録する"}
          </button>
          <p className="muted small">名前の変更は運営のみ可能です。入力ミスに気をつけてください。</p>
        </form>
      )}

      {state.kind === "registered" && (
        <section className="card reveal">
          <p className="muted">あなたの二つ名は…</p>
          <p className="epithet">〈{state.user.epithet}〉</p>
          <p className="name">{state.user.name}</p>
          <Link to="/" replace className="button primary">
            はじめる
          </Link>
          <p className="muted small">次回からはこの QR コードを読み込むだけでログインできます。</p>
        </section>
      )}
    </main>
  );
}

/** LINE 等のアプリ内ブラウザでは Cookie が通常のブラウザと共有されないため注意を出す */
function InAppBrowserNotice() {
  const ua = navigator.userAgent;
  if (!/\bLine\/|FBAN|FBAV|Instagram|Slack|Teams/i.test(ua)) return null;
  return (
    <p className="notice">
      アプリ内のブラウザで開いています。次回以降もログイン状態を保つには、スマホ標準のカメラで QR
      コードを読み込んでください。
    </p>
  );
}

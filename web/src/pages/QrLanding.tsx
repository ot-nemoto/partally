import { PIN_LENGTH, type QrLoginResponse, type RegisterResponse, type UserDto } from "@partally/shared";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";

type State =
  | { kind: "loading" }
  | { kind: "register" }
  /** ログインしていない端末で、暗証番号を入れる（setup: まだ決めていないので決める） */
  | { kind: "pin"; setup: boolean }
  | { kind: "registered"; user: UserDto }
  | { kind: "error"; message: string };

const pinPattern = new RegExp(`^\\d{${PIN_LENGTH}}$`);
/** 全角の数字は半角にそろえ、数字以外は入れない */
const toPin = (value: string) => value.normalize("NFKC").replace(/\D/g, "").slice(0, PIN_LENGTH);

export function QrLanding() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    api<QrLoginResponse>("POST", "/auth/qr", { token })
      .then((res) => {
        if (cancelled) return;
        if (res.status === "bound") navigate("/", { replace: true });
        else if (res.status === "pin_required") setState({ kind: "pin", setup: res.setup });
        else setState({ kind: "register" });
      })
      .catch((e) => !cancelled && setState({ kind: "error", message: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  /** 決めるときは、確認のため 2 回入れた番号がそろっているか */
  const needsAgain = state.kind === "register" || (state.kind === "pin" && state.setup);
  const pinProblem = !pinPattern.test(pin)
    ? undefined
    : needsAgain && pinAgain.length === PIN_LENGTH && pin !== pinAgain
      ? "暗証番号が 1 回目と 2 回目で違います。"
      : undefined;
  const pinReady = pinPattern.test(pin) && (!needsAgain || pin === pinAgain);

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(undefined);
    try {
      const res = await api<RegisterResponse>("POST", "/auth/register", { token, name, pin });
      setState({ kind: "registered", user: res.user });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onPin(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(undefined);
    try {
      const res = await api<QrLoginResponse>("POST", "/auth/qr", { token, pin });
      if (res.status === "bound") navigate("/", { replace: true });
      else if (res.status === "pin_required") {
        // 決めている間に、別の端末で先に決められた。決めた番号を入れてもらう
        setState({ kind: "pin", setup: res.setup });
        setPin("");
        setPinAgain("");
        setFormError("この QR コードの暗証番号は、先に決められていました。その番号を入れてください。");
      } else setState({ kind: "register" });
    } catch (err) {
      setPin("");
      setPinAgain("");
      if (err instanceof ApiError && err.code === "pin_locked") setState({ kind: "error", message: errorMessage(err) });
      else setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const pinFields = (autoFocus: boolean) => (
    <>
      <label className="field">
        <span>暗証番号（数字 {PIN_LENGTH} 桁）</span>
        <input
          className="pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(toPin(e.target.value))}
          maxLength={PIN_LENGTH}
          // biome-ignore lint/a11y/noAutofocus: この画面で入れるのは暗証番号だけ
          autoFocus={autoFocus}
          required
        />
      </label>
      {needsAgain && (
        <label className="field">
          <span>暗証番号（確認のため、もう一度）</span>
          <input
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pinAgain}
            onChange={(e) => setPinAgain(toPin(e.target.value))}
            maxLength={PIN_LENGTH}
            required
          />
        </label>
      )}
      {pinProblem && <p className="error">{pinProblem}</p>}
    </>
  );

  return (
    <main className="page">
      <InAppBrowserNotice />
      {state.kind === "loading" && <p className="muted">読み込み中…</p>}

      {state.kind === "error" && <p className="error">{state.message}</p>}

      {state.kind === "register" && (
        <form className="card" onSubmit={onRegister}>
          <h1>ようこそ！</h1>
          <p>お名前と暗証番号を入力してください。あなただけの「二つ名」が授けられます。</p>
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
          {pinFields(false)}
          <p className="muted small">
            暗証番号は、別のスマホやブラウザでこの QR コードを読み込んだときに聞かれます。QR
            コードを他の人に使われないためのものなので、忘れないようにしてください。
          </p>
          {formError && <p className="error">{formError}</p>}
          <button type="submit" className="primary" disabled={submitting || name.trim() === "" || !pinReady}>
            {submitting ? "登録中…" : "登録する"}
          </button>
          <p className="muted small">名前の変更は運営のみ可能です。入力ミスに気をつけてください。</p>
        </form>
      )}

      {state.kind === "pin" && (
        <form className="card" onSubmit={onPin}>
          <h1>{state.setup ? "暗証番号を決めてください" : "暗証番号を入れてください"}</h1>
          <p>
            {state.setup
              ? "この QR コードには、まだ暗証番号がありません。別のスマホやブラウザで読み込んだときに聞かれる番号を決めてください。"
              : "この QR コードは登録済みです。登録したときに決めた暗証番号を入れると、ログインできます。"}
          </p>
          {pinFields(true)}
          {formError && <p className="error">{formError}</p>}
          <button type="submit" className="primary" disabled={submitting || !pinReady}>
            {submitting ? "確認中…" : state.setup ? "決めてログイン" : "ログイン"}
          </button>
          {!state.setup && <p className="muted small">暗証番号を忘れたときは、運営に声をかけてください。</p>}
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
          <p className="muted small">
            次回からはこの QR コードを読み込むだけでログインできます（別のスマホやブラウザでは暗証番号を聞かれます）。
          </p>
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

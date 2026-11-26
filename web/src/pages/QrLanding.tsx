import { PIN_LENGTH, type QrLoginResponse, type RegisterResponse, type UserDto } from "@partally/shared";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { LanguageSwitch, useT } from "../i18n";

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
  const t = useT();

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
      ? t("暗証番号が 1 回目と 2 回目で違います。", "The two PINs don’t match.")
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
        setFormError(
          t(
            "この QR コードの暗証番号は、先に決められていました。その番号を入れてください。",
            "A PIN was already set for this QR code. Please enter that PIN.",
          ),
        );
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
        <span>{t(`暗証番号（数字 ${PIN_LENGTH} 桁）`, `PIN (${PIN_LENGTH} digits)`)}</span>
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
          <span>{t("暗証番号（確認のため、もう一度）", "PIN (again, to confirm)")}</span>
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
      <div className="lang-row">
        <LanguageSwitch />
      </div>
      <InAppBrowserNotice />
      {state.kind === "loading" && <p className="muted">{t("読み込み中…", "Loading…")}</p>}

      {state.kind === "error" && <p className="error">{state.message}</p>}

      {state.kind === "register" && (
        <form className="card" onSubmit={onRegister}>
          <h1>{t("ようこそ！", "Welcome!")}</h1>
          <p>
            {t(
              "お名前と暗証番号を入力してください。あなただけの「二つ名」が授けられます。",
              "Enter your name and a PIN. You’ll be given your own title (二つ名).",
            )}
          </p>
          <label className="field">
            <span>{t("お名前", "Your name")}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder={t("例：田中", "e.g. Alex")}
              autoComplete="name"
              required
            />
          </label>
          {pinFields(false)}
          <p className="muted small">
            {t(
              "暗証番号は、別のスマホやブラウザでこの QR コードを読み込んだときに聞かれます。QR コードを他の人に使われないためのものなので、忘れないようにしてください。",
              "You’ll be asked for this PIN when you scan this QR code on another phone or browser. It keeps others from using your QR code, so please remember it.",
            )}
          </p>
          {formError && <p className="error">{formError}</p>}
          <button type="submit" className="primary" disabled={submitting || name.trim() === "" || !pinReady}>
            {submitting ? t("登録中…", "Registering…") : t("登録する", "Register")}
          </button>
          <p className="muted small">
            {t(
              "名前の変更は運営のみ可能です。入力ミスに気をつけてください。",
              "Only the organizers can change your name, so please check it carefully.",
            )}
          </p>
          <p className="small privacy-link">
            {/* 入れかけた名前と暗証番号が消えないよう、別のタブで開く */}
            <Link to="/privacy" target="_blank" rel="noopener">
              {t("データの扱い（お名前・写真などをどう扱うか）", "How we handle your data (name, photos, etc.)")}
            </Link>
          </p>
        </form>
      )}

      {state.kind === "pin" && (
        <form className="card" onSubmit={onPin}>
          <h1>
            {state.setup
              ? t("暗証番号を決めてください", "Choose a PIN")
              : t("暗証番号を入れてください", "Enter your PIN")}
          </h1>
          <p>
            {state.setup
              ? t(
                  "この QR コードには、まだ暗証番号がありません。別のスマホやブラウザで読み込んだときに聞かれる番号を決めてください。",
                  "This QR code has no PIN yet. Choose the PIN you’ll be asked for when you scan it on another phone or browser.",
                )
              : t(
                  "この QR コードは登録済みです。登録したときに決めた暗証番号を入れると、ログインできます。",
                  "This QR code is already registered. Enter the PIN you chose when registering to log in.",
                )}
          </p>
          {pinFields(true)}
          {formError && <p className="error">{formError}</p>}
          <button type="submit" className="primary" disabled={submitting || !pinReady}>
            {submitting
              ? t("確認中…", "Checking…")
              : state.setup
                ? t("決めてログイン", "Set PIN and log in")
                : t("ログイン", "Log in")}
          </button>
          {!state.setup && (
            <p className="muted small">
              {t(
                "暗証番号を忘れたときは、運営に声をかけてください。",
                "If you forgot your PIN, please ask the organizers.",
              )}
            </p>
          )}
        </form>
      )}

      {state.kind === "registered" && (
        <section className="card reveal">
          <p className="muted">{t("あなたの二つ名は…", "Your title (二つ名) is…")}</p>
          <p className="epithet">〈{state.user.epithet}〉</p>
          <p className="name">{state.user.name}</p>
          <Link to="/" replace className="button primary">
            {t("はじめる", "Start")}
          </Link>
          <p className="muted small">
            {t(
              "次回からはこの QR コードを読み込むだけでログインできます（別のスマホやブラウザでは暗証番号を聞かれます）。",
              "Next time, just scan this QR code to log in (on another phone or browser you’ll be asked for your PIN).",
            )}
          </p>
        </section>
      )}
    </main>
  );
}

/** LINE 等のアプリ内ブラウザでは Cookie が通常のブラウザと共有されないため注意を出す */
function InAppBrowserNotice() {
  const t = useT();
  const ua = navigator.userAgent;
  if (!/\bLine\/|FBAN|FBAV|Instagram|Slack|Teams/i.test(ua)) return null;
  return (
    <p className="notice">
      {t(
        "アプリ内のブラウザで開いています。次回以降もログイン状態を保つには、スマホ標準のカメラで QR コードを読み込んでください。",
        "You’re in an in-app browser. To stay logged in next time, scan the QR code with your phone’s standard camera.",
      )}
    </p>
  );
}

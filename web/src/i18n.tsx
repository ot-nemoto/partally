import { createContext, type ReactNode, useCallback, useContext, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * 画面の言語（日本語・英語）。文言は呼ぶ所に日本語と英語を並べて書く（`t("日本語", "English")`）。
 * 選んだ言語はブラウザに覚え、選んでいなければブラウザの言語設定で決める（日本語以外は英語）。
 * 幹事や参加者が入れた内容（ゲームの問題・スケジュール・名前など）と二つ名は訳さない
 */
export type Lang = "ja" | "en";

const STORAGE_KEY = "partally-lang";

/** 覚えた言語、無ければブラウザの言語設定から決める */
export function initialLang(stored: string | null, languages: readonly string[]): Lang {
  if (stored === "ja" || stored === "en") return stored;
  const first = languages[0]?.toLowerCase() ?? "ja";
  return first.startsWith("ja") ? "ja" : "en";
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let current: Lang = initialLang(
  readStored(),
  typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language],
);
const listeners = new Set<() => void>();
applyDocumentLang(current);

/** 言語を固定している画面（英語に対応していない管理画面）。固定している間は、選んだ言語より優先する */
let fixed: Lang | undefined;
const FixedLangContext = createContext<Lang | undefined>(undefined);

function applyDocumentLang(lang: Lang) {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

/** 今の言語（React の外で使う。画面の中では useLang・useT を使う） */
export function getLang(): Lang {
  return fixed ?? current;
}

/** 選んだ言語（固定していても、選んだ方を返す） */
function getChosenLang(): Lang {
  return current;
}

/** 言語を変えて覚える。表示中の画面はすぐ切り替わる */
export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 覚えられなくても、開いている間は切り替える
  }
  applyDocumentLang(fixed ?? lang);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLang(): Lang {
  const chosen = useSyncExternalStore(subscribe, getChosenLang, getChosenLang);
  return useContext(FixedLangContext) ?? chosen;
}

/** 今の言語で、日本語と英語のどちらかを選ぶ（React の外で使う） */
export function tr(ja: string, en: string): string {
  return getLang() === "en" ? en : ja;
}

/**
 * 中の画面の言語を固定する（選んだ言語は変えない）。英語に対応していない管理画面を日本語で出すために使う。
 * 共通の部品（写真の拡大・ランキングの表など）とエラーの文も、固定した言語にそろう
 */
export function FixedLang({ lang, children }: { lang: Lang; children: ReactNode }) {
  // 中の画面を描く前に固定する（初めて描くときに tr()・errorMessage を呼んでも固定した言語になる）
  fixed = lang;
  useLayoutEffect(() => {
    fixed = lang;
    applyDocumentLang(lang);
    return () => {
      fixed = undefined;
      applyDocumentLang(current);
    };
  }, [lang]);
  return <FixedLangContext.Provider value={lang}>{children}</FixedLangContext.Provider>;
}

/** 画面の中で使う、言語に合わせて文言を選ぶ関数。言語が変わると画面を描き直す */
export function useT(): (ja: string, en: string) => string {
  const lang = useLang();
  return useCallback((ja: string, en: string) => (lang === "en" ? en : ja), [lang]);
}

/** 英語の点数（1 pt / 2 pts） */
export function pts(n: number): string {
  return `${n} ${n === 1 ? "pt" : "pts"}`;
}

/** 英語の人数（1 person / 2 people） */
export function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** 日本語・English の切り替え */
export function LanguageSwitch({ className }: { className?: string }) {
  const lang = useLang();
  return (
    // biome-ignore lint/a11y/useSemanticElements: ボタン 2 つのまとまりなので fieldset ではなく group にする
    <div className={`lang-switch${className ? ` ${className}` : ""}`} role="group" aria-label="Language / 言語">
      <button type="button" lang="ja" aria-pressed={lang === "ja"} onClick={() => setLang("ja")}>
        日本語
      </button>
      <button type="button" lang="en" aria-pressed={lang === "en"} onClick={() => setLang("en")}>
        English
      </button>
    </div>
  );
}

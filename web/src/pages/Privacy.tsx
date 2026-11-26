import { DEVICE_ACCOUNTS_MAX } from "@partally/shared";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { LanguageSwitch, useT } from "../i18n";

/**
 * 参加者向けの「データの扱い」（#291）。参加者のデータを、何を集め、誰に何が見え、いつ消すかを説明する。
 * ログインしていなくても開ける（QR を読み込んで登録する前に読めるように）。
 * 書いてある内容は今の動きに合わせている。動きを変えたら、ここも直す（docs/spec.md の「データの扱い」）
 */
export function Privacy() {
  const t = useT();
  const navigate = useNavigate();
  // 別のタブで開いたときや、URL を直接開いたときは戻る先が無いので、トップへ
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate("/"));

  return (
    <main className="page privacy">
      <div className="lang-row">
        <LanguageSwitch />
      </div>
      <section className="card">
        <h1>{t("データの扱い", "How we handle your data")}</h1>
        <p>
          {t(
            "このアプリで、あなたのデータを何に使い、誰に見え、いつ消すかをまとめています。",
            "This page explains what data this app keeps about you, who can see it, and when it is deleted.",
          )}
        </p>
      </section>

      <Section title={t("集めるもの", "What we keep")}>
        <li>
          {t(
            "登録のときに入れたお名前と、自動で付く「二つ名」",
            "The name you enter when registering, and the title (二つ名) you are given",
          )}
        </li>
        <li>
          {t(
            "暗証番号。そのままは保存せず、照合のための形に変えて保存します。幹事にも見えません",
            "Your PIN. It is not stored as is, only in a form used to check it. The organizers can’t see it either",
          )}
        </li>
        <li>
          {t(
            "あなたが送った写真、お気に入りに選んだ写真、ゲームの答え",
            "Photos you send, photos you choose as favorites, and your game answers",
          )}
        </li>
      </Section>

      <Section title={t("写真", "Photos")}>
        <li>
          {t(
            "写真はスマホの中で縮小して送ります。そのとき、位置情報などの撮影情報は消えるので、送りません",
            "Photos are resized on your phone before sending. Location and other camera details are removed, so they are not sent",
          )}
        </li>
        <li>
          {t(
            "幹事の確認待ちの写真は、あなたと幹事にしか見えません",
            "Photos waiting for review can only be seen by you and the organizers",
          )}
        </li>
        <li>
          {t(
            "公開された写真は、参加者みんなに、あなたのお名前と一緒に見えます",
            "Public photos can be seen by all participants, together with your name",
          )}
        </li>
        <li>
          {t(
            "幹事が公開しなかった写真や削除した写真は、ほかの参加者には見えません",
            "Photos the organizers don’t publish or delete can’t be seen by other participants",
          )}
        </li>
      </Section>

      <Section title={t("ほかの参加者に見えるもの", "What other participants can see")}>
        <li>
          {t(
            "ランキングなどを公開したとき：お名前・二つ名・ポイント（幹事がお名前やポイントを伏せることもあります）",
            "When rankings are shown: your name, title, and points (the organizers may hide names or points)",
          )}
        </li>
        <li>
          {t(
            "投票のゲームでは、投票先を選べるように、参加者のお名前と二つ名の一覧が出ます",
            "In vote games, a list of participants’ names and titles is shown so people can choose",
          )}
        </li>
        <li>
          {t(
            "ゲームの結果を公開したとき：優勝や上位、抽選の当選などに入った人のお名前と二つ名（クイズでは出ません）",
            "When game results are shown: the names and titles of people who won, placed, or were drawn in a lottery (not for quizzes)",
          )}
        </li>
        <li>
          {t(
            "誰がお気に入りに選んだか、写真に付いたお気に入りの数、ゲームで何と答えたか、投票で誰に入れたかは、ほかの参加者には見えません（お気に入りの数は、ポイントを見せる設定のとき、写真を送った本人に見えます）",
            "Other participants can’t see who chose a favorite, how many favorites a photo has, what you answered in games, or who you voted for (when points are shown, the person who sent a photo can see its favorite count)",
          )}
        </li>
      </Section>

      <Section title={t("幹事に見えるもの", "What the organizers can see")}>
        <li>
          {t(
            "参加者の一覧（お名前・二つ名・ポイントとその内訳）",
            "The list of participants (names, titles, and points with their breakdown)",
          )}
        </li>
        <li>{t("確認待ちを含む、すべての写真", "All photos, including those waiting for review")}</li>
        <li>{t("ゲームの答え（投票で誰に入れたかを含む）", "Game answers (including who you voted for)")}</li>
      </Section>

      <Section title={t("スマホに残すもの", "What is kept on your phone")}>
        <li>
          {t(
            `ログインの情報（Cookie。30 日間）と、この端末で使う参加者の一覧（${DEVICE_ACCOUNTS_MAX} 人まで）`,
            `Login information (a cookie, for 30 days) and the list of people using this phone (up to ${DEVICE_ACCOUNTS_MAX})`,
          )}
        </li>
        <li>{t("表示の言語", "Your display language")}</li>
        <li>
          {t(
            "電波が悪くて送れなかった写真（送れるまで）",
            "Photos that couldn’t be sent because of a weak signal (until they are sent)",
          )}
        </li>
      </Section>

      <Section title={t("使わないもの", "What we don’t use")}>
        <li>
          {t(
            "広告や、アクセスを解析するための外部のサービスは使いません",
            "We don’t use advertising or outside services that analyze your visits",
          )}
        </li>
      </Section>

      <Section title={t("消すとき", "When data is deleted")}>
        <li>
          {t(
            "イベントが終わったら、運営がデータをまとめて消します（写真も含みます）",
            "After the event, the organizers delete all the data together (including photos)",
          )}
        </li>
        <li>
          {t(
            "分からないことや、消してほしいものがあるときは、幹事に声をかけてください",
            "If you have questions or want something deleted, please ask the organizers",
          )}
        </li>
      </Section>

      <button type="button" onClick={back}>
        {t("戻る", "Back")}
      </button>
    </main>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{props.title}</h2>
      <ul>{props.children}</ul>
    </section>
  );
}

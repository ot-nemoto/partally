import { ordinal, type Rules, type StandingResponse } from "@partally/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { CaptureButtons } from "../components/CaptureButtons";
import { useParticipant } from "../components/ParticipantLayout";
import { PrizeImage } from "../components/PrizeChips";
import { useLang, useT } from "../i18n";
import { subscribeQueue } from "../photos/queue";

export function Home() {
  const { user, rules, reloadUser } = useParticipant();
  const t = useT();

  // 他の画面にいる間に承認された分などを反映する
  useEffect(reloadUser, [reloadUser]);

  // 送信が終わったらアップロード数を取り直す（サーバ側の登録が少し遅れることがある）
  useEffect(() => {
    let previous = 0;
    return subscribeQueue((s) => {
      if (s.waiting < previous) setTimeout(reloadUser, 1500);
      previous = s.waiting;
    });
  }, [reloadUser]);

  const points = (n: number) => t(`${n} ポイント`, n === 1 ? "1 point" : `${n} points`);
  const sep = t("・", " · ");

  return (
    <>
      <section className="card profile">
        <p className="epithet">〈{user.epithet}〉</p>
        <p className="name">{user.name}</p>
      </section>
      <HomeStanding rules={rules} userId={user.userId} />
      <CaptureButtons />
      <section className="card">
        {/* ポイント・クイズ・ゲームの点数を伏せている間は出さない（API からも返らない） */}
        {rules.showPoints && (
          <p className="points">
            <span className="points-value">{user.points}</span>
            <span className="points-unit">{t("ポイント", user.points === 1 ? "point" : "points")}</span>
          </p>
        )}
        <dl className="stats">
          <div>
            <dt>{t("公開中の写真", "Public photos")}</dt>
            <dd>{user.approvedCount}</dd>
          </div>
          {rules.showPoints && (
            <div>
              <dt>{t("お気に入りに選ばれた", "Favorited by others")}</dt>
              <dd>{user.favoritesReceived}</dd>
            </div>
          )}
          {rules.showGamePoints && (
            <div>
              <dt>{t("ゲームの点数", "Game points")}</dt>
              <dd>{user.gamePoints}</dd>
            </div>
          )}
        </dl>
        {rules.showGamePoints && user.gameAwards && user.gameAwards.length > 0 && (
          <ul className="game-awards">
            {user.gameAwards.map((a, i) => (
              // 同じゲーム・枠の組は 1 人に 1 つだけだが、名前が同じゲームもあり得るので順番を混ぜる
              // biome-ignore lint/suspicious/noArrayIndexKey: 並びは確定した順で、途中に増えたりしない
              <li key={i}>
                <span>
                  {a.gameName} <strong>{a.slotName}</strong>
                </span>
                <span className="game-award-points">+{a.points}</span>
              </li>
            ))}
          </ul>
        )}
        {(rules.showPoints || rules.showGamePoints) && (
          <p className="muted small">
            {rules.showPoints && (
              <>
                {t(`写真 1 枚公開で ${points(rules.uploadPoints)}`, `Each public photo: ${points(rules.uploadPoints)}`)}
                {rules.favoritePoints > 0 &&
                  sep +
                    t(
                      `お気に入りに 1 回選ばれると ${points(rules.favoritePoints)}`,
                      `each favorite you receive: ${points(rules.favoritePoints)}`,
                    )}
                {/* 選べないとき（受付終了・上限 0）は、選んだときの点数を案内しない */}
                {rules.favoritesEnabled &&
                  rules.favoriteLimit > 0 &&
                  rules.favoriteGivenPoints > 0 &&
                  sep +
                    t(
                      `お気に入りを 1 枚選ぶと ${points(rules.favoriteGivenPoints)}`,
                      `each favorite you give: ${points(rules.favoriteGivenPoints)}`,
                    )}
              </>
            )}
            {rules.showGamePoints &&
              `${rules.showPoints ? sep : ""}${t(
                "ゲーム（クイズを含む）は結果が決まると、選んだ答えや入った枠の点数が入ります",
                "games (including quizzes) award points when the results are final",
              )}`}
          </p>
        )}
        {rules.favoritesEnabled && (
          <p className="muted small">
            {t(
              `お気に入り：${user.favoritesGiven} / ${rules.favoriteLimit} 枚選択中（「みんなの写真」で ♡ を押して選べます）`,
              `Favorites: ${user.favoritesGiven} / ${rules.favoriteLimit} chosen (tap ♡ in “Everyone”)`,
            )}
          </p>
        )}
      </section>
      <p className="small privacy-link">
        <Link to="/privacy">{t("データの扱い", "How we handle your data")}</Link>
      </p>
    </>
  );
}

/**
 * イベントを終了した後、管理者がオンにしたときだけ、自分の順位とその順位の景品を見せる。
 * 設定が変わったら取り直す（API も、終了していないかオフなら返さない）
 */
function HomeStanding({ rules, userId }: { rules: Rules; userId: string }) {
  const t = useT();
  const lang = useLang();
  const [standing, setStanding] = useState<StandingResponse>();
  const enabled = rules.eventEndedAt !== undefined && (rules.homeRankVisible || rules.homePrizeVisible);
  // 終了した時刻・設定・参加者が変わったら取り直す（見せないときは空）
  const requestKey = enabled
    ? [rules.eventEndedAt, rules.homeRankVisible, rules.homePrizeVisible, userId].join("|")
    : "";

  useEffect(() => {
    setStanding(undefined);
    if (!requestKey) return;
    let active = true;
    // 読めなかったとき（設定が変わった直後の 404 など）は出さない
    api<StandingResponse>("GET", "/me/standing")
      .then((res) => active && setStanding(res))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [requestKey]);

  if (!enabled || !standing) return null;
  const { rank, prizes } = standing;
  if (rank === undefined && !prizes?.length) return null;
  return (
    <section className="card home-standing-card">
      {rank !== undefined && (
        <p className="home-rank">
          <span className="muted small">{t("あなたの順位", "Your rank")}</span>
          <span className="home-rank-value">{lang === "en" ? ordinal(rank) : `${rank} 位`}</span>
        </p>
      )}
      {prizes && prizes.length > 0 && (
        <ul className="home-prizes">
          {prizes.map((p) => (
            <li key={p.prizeId}>
              <PrizeImage prize={p} />
              <span className="home-prize-name">{p.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

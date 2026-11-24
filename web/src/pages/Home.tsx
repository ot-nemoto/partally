import { useEffect } from "react";
import { AccountSwitcher } from "../components/AccountSwitcher";
import { CaptureButtons } from "../components/CaptureButtons";
import { useParticipant } from "../components/ParticipantLayout";
import { useT } from "../i18n";
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
      <AccountSwitcher />
    </>
  );
}

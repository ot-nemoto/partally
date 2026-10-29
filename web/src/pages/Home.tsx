import { useEffect } from "react";
import { CaptureButtons } from "../components/CaptureButtons";
import { useParticipant } from "../components/ParticipantLayout";
import { subscribeQueue } from "../photos/queue";

export function Home() {
  const { user, rules, reloadUser } = useParticipant();

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

  return (
    <>
      <section className="card profile">
        <p className="epithet">〈{user.epithet}〉</p>
        <p className="name">{user.name}</p>
      </section>
      <CaptureButtons />
      <section className="card">
        {/* ポイント・クイズの点数を伏せている間は出さない（API からも返らない） */}
        {rules.showPoints && (
          <p className="points">
            <span className="points-value">{user.points}</span>
            <span className="points-unit">ポイント</span>
          </p>
        )}
        <dl className="stats">
          <div>
            <dt>公開中の写真</dt>
            <dd>{user.approvedCount}</dd>
          </div>
          {rules.showPoints && (
            <div>
              <dt>お気に入りに選ばれた</dt>
              <dd>{user.favoritesReceived}</dd>
            </div>
          )}
          <div>
            <dt>回答した問題</dt>
            <dd>{user.quizAnswered}</dd>
          </div>
          {rules.showQuizPoints && (
            <div>
              <dt>クイズの点数</dt>
              <dd>{user.quizPoints}</dd>
            </div>
          )}
        </dl>
        {(rules.showPoints || rules.showQuizPoints) && (
          <p className="muted small">
            {rules.showPoints && (
              <>
                写真 1 枚公開で {rules.uploadPoints} ポイント
                {rules.favoritePoints > 0 && `・お気に入りに 1 回選ばれると ${rules.favoritePoints} ポイント`}
                {rules.favoriteGivenPoints > 0 && `・お気に入りを 1 枚選ぶと ${rules.favoriteGivenPoints} ポイント`}
              </>
            )}
            {rules.showPoints && rules.showQuizPoints && "・"}
            {rules.showQuizPoints && "クイズは締め切り後に、選んだ答えの点数が入ります"}
          </p>
        )}
        {rules.favoritesEnabled && (
          <p className="muted small">
            お気に入り：{user.favoritesGiven} / {rules.favoriteLimit} 枚選択中（「みんなの写真」で ♡ を押して選べます）
          </p>
        )}
      </section>
    </>
  );
}

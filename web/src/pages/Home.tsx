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
      {rules.showPoints && (
        <section className="card">
          <p className="points">
            <span className="points-value">{user.points}</span>
            <span className="points-unit">ポイント</span>
          </p>
          <dl className="stats">
            <div>
              <dt>公開中の写真</dt>
              <dd>{user.approvedCount}</dd>
            </div>
            <div>
              <dt>お気に入りに選ばれた</dt>
              <dd>{user.favoritesReceived}</dd>
            </div>
          </dl>
          <p className="muted small">
            写真 1 枚公開で {rules.uploadPoints} ポイント
            {rules.favoritePoints > 0 && `・お気に入りに 1 回選ばれると ${rules.favoritePoints} ポイント`}
          </p>
        </section>
      )}
      {rules.favoritesEnabled && (
        <section className="card">
          <p className="muted small">
            お気に入り：{user.favoritesGiven} / {rules.favoriteLimit} 枚選択中（「みんなの写真」で ♡ を押して選べます）
          </p>
        </section>
      )}
    </>
  );
}

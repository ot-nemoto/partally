import { useEffect } from "react";
import { CaptureButtons } from "../components/CaptureButtons";
import { useParticipant } from "../components/ParticipantLayout";
import { subscribeQueue } from "../photos/queue";

export function Home() {
  const { user, reloadUser } = useParticipant();

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
        <dl className="stats">
          <div>
            <dt>アップロード</dt>
            <dd>{user.uploadCount}</dd>
          </div>
          <div>
            <dt>公開中</dt>
            <dd>{user.approvedCount}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}

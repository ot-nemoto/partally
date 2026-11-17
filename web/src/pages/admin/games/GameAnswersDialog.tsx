import {
  formatRankRange,
  type GameAnswersResponse,
  type GameDto,
  normalizeKeyword,
  ordinal,
  rankNumberAnswers,
  rankRangeOf,
  tallyVotes,
} from "@partally/shared";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../../api";
import { Modal } from "../../../components/Modal";
import { formatRecentTime } from "../../../format";
import { people, pts, useLang, useT } from "../../../i18n";

/** 参加者が答える形式（クイズ・数値予想・投票・合言葉・抽選）で、だれが何を答えたか */
export function GameAnswersDialog(props: { game: GameDto; onClose: () => void }) {
  const t = useT();
  const [data, setData] = useState<GameAnswersResponse>();
  // ポイントの計算と同じく、確定したゲームでは確定より後に届いた答えを数えない
  const confirmedAt = data?.game.status === "confirmed" ? data.game.confirmedAt : undefined;
  const isLate = (a: { answeredAt: string }) => confirmedAt !== undefined && a.answeredAt > confirmedAt;
  const counted = data?.answers.filter((a) => !isLate(a));
  const late = data?.answers.filter(isLate) ?? [];
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<GameAnswersResponse>("GET", `/admin/games/${props.game.gameId}/answers`)
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, [props.game.gameId]);

  return (
    <Modal className="dialog game-dialog" label={t("回答者", "Answers")} onClose={props.onClose}>
      <div className="card">
        <h2>{t("回答者", "Answers")}</h2>
        <p className="small">{props.game.name}</p>
        {props.game.imageUrl && <img className="game-image" src={props.game.imageUrl} alt="" />}
        {props.game.description && <p className="quiz-text">{props.game.description}</p>}
        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="muted">{t("読み込み中…", "Loading…")}</p>}
        {counted && late.length > 0 && (
          <p className="muted small">
            {t(
              `確定より後に届いた答え（${late.length} 件）は、ポイントと同じく数えていません。`,
              late.length === 1
                ? "1 answer that arrived after finalizing isn’t counted, same as for points."
                : `${late.length} answers that arrived after finalizing aren’t counted, same as for points.`,
            )}
          </p>
        )}
        {data?.game.format === "number" && counted && <NumberAnswers game={data.game} answers={counted} />}
        {data?.game.format === "vote" && counted && <VoteAnswers game={data.game} answers={counted} />}
        {data?.game.format === "keyword" && counted && <KeywordAnswers game={data.game} answers={counted} />}
        {data?.game.format === "lottery" && counted && <LotteryAnswers game={data.game} answers={counted} />}
        {data?.game.choices.map((ch) => {
          const names = (counted ?? []).filter((a) => a.choiceId === ch.choiceId);
          return (
            <section key={ch.choiceId} className="quiz-result">
              <h3 className="game-choice-label">
                {ch.imageUrl && <img className="game-choice-thumb" src={ch.imageUrl} alt="" />}
                {ch.text}
                <span className="muted small">
                  {" "}
                  {t(`${ch.points} 点・${names.length} 人`, `${pts(ch.points)} · ${people(names.length)}`)}
                </span>
              </h3>
              {names.length > 0 ? (
                <p className="small">
                  {names.map((a) => a.displayName ?? t("（不明なユーザ）", "(unknown user)")).join(t("、", ", "))}
                </p>
              ) : (
                <p className="muted small">{t("なし", "None")}</p>
              )}
            </section>
          );
        })}
        <div className="buttons">
          <button type="button" onClick={props.onClose}>
            {t("閉じる", "Close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 数値予想で、だれが何を答えたか（正解の数があれば、近い順に順位と点数も） */
function NumberAnswers(props: { game: GameDto; answers: GameAnswersResponse["answers"] }) {
  const t = useT();
  const { game } = props;
  const answers = props.answers.filter((a): a is typeof a & { value: number } => a.value !== undefined);
  if (answers.length === 0) return <p className="muted small">{t("まだ答えがありません。", "No answers yet.")}</p>;
  const correct = game.correctNumber;
  if (correct === undefined) {
    const sorted = [...answers].sort((a, b) => a.value - b.value);
    return (
      <>
        <p className="muted small">
          {t("正解の数を入れると、順位と点数が出ます。", "Enter the correct number to see ranks and points.")}
        </p>
        <table className="game-number-answers">
          <thead>
            <tr>
              <th>{t("答え", "Answer")}</th>
              <th>{t("名前", "Name")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.userId}>
                <td className="num">{a.value}</td>
                <td>{a.displayName ?? t("（不明なユーザ）", "(unknown user)")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }
  const results = rankNumberAnswers(
    answers.map((a) => a.value),
    correct,
    game.ranks,
  );
  const rows = answers.map((a, i) => ({ answer: a, ...results[i]! })).sort((a, b) => a.rank - b.rank);
  return (
    <>
      <p className="small">
        {t("正解: ", "Correct: ")}
        <strong>{correct}</strong>
      </p>
      <table className="game-number-answers">
        <thead>
          <tr>
            <th>{t("順位", "Rank")}</th>
            <th>{t("答え", "Answer")}</th>
            <th>{t("差", "Difference")}</th>
            <th>{t("名前", "Name")}</th>
            <th>{t("点数", "Points")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.answer.userId}>
              <td className="num">{t(`${r.rank} 位`, ordinal(r.rank))}</td>
              <td className="num">{r.answer.value}</td>
              <td className="num">{r.diff}</td>
              <td>{r.answer.displayName ?? t("（不明なユーザ）", "(unknown user)")}</td>
              <td className="num">{t(`${r.points} 点`, pts(r.points))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** 抽選で、確定する前は参加した人、確定した後は引いた順番と点数 */
function LotteryAnswers(props: { game: GameDto; answers: GameAnswersResponse["answers"] }) {
  const t = useT();
  const lang = useLang();
  const { game } = props;
  const names = new Map(props.answers.map((a) => [a.userId, a.displayName ?? t("（不明なユーザ）", "(unknown user)")]));
  if (!game.drawOrder) {
    return (
      <>
        <p className="small">
          {t(
            `参加 ${props.answers.length} 人（確定したときに抽選します）`,
            `${props.answers.length} entered (the draw happens when you finalize)`,
          )}
        </p>
        <p className="small">
          {props.answers.map((a) => names.get(a.userId)).join(t("、", ", ")) ||
            t("まだ参加した人がいません。", "No one has entered yet.")}
        </p>
      </>
    );
  }
  const winners = game.drawOrder.flatMap((userId, i) => {
    const range = rankRangeOf(game.ranks, i + 1);
    return range ? [{ userId, order: i + 1, range }] : [];
  });
  // 参加したのに抽選に入っていない人（紐づけを解除した人と、確定の直前に参加して読み取りに間に合わなかった人）
  const drawn = new Set(game.drawOrder);
  const missed = props.answers.filter((a) => a.entry && !drawn.has(a.userId));
  return (
    <>
      <p className="small">
        {t(
          `参加 ${game.drawOrder.length} 人・当選 ${winners.length} 人`,
          `${game.drawOrder.length} entered · ${winners.length} won`,
        )}
      </p>
      {winners.length === 0 ? (
        <p className="muted small">{t("当選した人はいません。", "No winners.")}</p>
      ) : (
        <table className="game-number-answers">
          <thead>
            <tr>
              <th>{t("順番", "Order")}</th>
              <th>{t("名前", "Name")}</th>
              <th>{t("当選", "Prize")}</th>
              <th>{t("点数", "Points")}</th>
            </tr>
          </thead>
          <tbody>
            {winners.map((w) => (
              <tr key={w.userId}>
                <td className="num">{w.order}</td>
                <td>{names.get(w.userId) ?? t("（不明なユーザ）", "(unknown user)")}</td>
                <td>{formatRankRange(w.range, "等", lang)}</td>
                <td className="num">{t(`${w.range.points} 点`, pts(w.range.points))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {missed.length > 0 && (
        <p className="muted small">
          {t(
            `抽選に入っていない参加者（${missed.length} 人）: ${missed.map((a) => names.get(a.userId)).join("、")}。紐づけを解除した人と、確定の直前に参加して間に合わなかった人です。入れるなら確定を取り消してもう一度確定します（引き直しになります）。`,
            `Entrants not in the draw (${missed.length}): ${missed.map((a) => names.get(a.userId)).join(", ")}. These are unlinked people and people who entered just before finalizing. To include them, undo finalizing and finalize again (this redraws).`,
          )}
        </p>
      )}
    </>
  );
}

/** 合言葉で、正解した順に番号・名前・入れた言葉・点数（今の合言葉に合わない答えは数えない） */
function KeywordAnswers(props: { game: GameDto; answers: GameAnswersResponse["answers"] }) {
  const t = useT();
  const { game } = props;
  const keyword = normalizeKeyword(game.keyword ?? "");
  const correct = props.answers
    .filter((a) => a.text !== undefined && normalizeKeyword(a.text) === keyword)
    .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt) || a.userId.localeCompare(b.userId));
  const stale = props.answers.length - correct.length;
  if (correct.length === 0 && stale === 0)
    return <p className="muted small">{t("まだ正解した人がいません。", "No correct answers yet.")}</p>;
  return (
    <>
      <p className="small">
        {t(`正解 ${correct.length} 人`, `${correct.length} correct`)}
        {stale > 0 &&
          t(
            `（合言葉を直す前に正解した ${stale} 人は数えません）`,
            ` (${stale} who answered correctly before the keyword was changed aren’t counted)`,
          )}
      </p>
      <table className="game-number-answers">
        <thead>
          <tr>
            <th>{t("順", "Order")}</th>
            <th>{t("名前", "Name")}</th>
            <th>{t("入れた言葉", "Entered word")}</th>
            <th>{t("時刻", "Time")}</th>
            <th>{t("点数", "Points")}</th>
          </tr>
        </thead>
        <tbody>
          {correct.map((a, i) => (
            <tr key={a.userId}>
              <td className="num">{t(`${i + 1} 番目`, ordinal(i + 1))}</td>
              <td>{a.displayName ?? t("（不明なユーザ）", "(unknown user)")}</td>
              <td>{a.text}</td>
              <td className="num">{formatRecentTime(a.answeredAt)}</td>
              <td className="num">
                {t(
                  `${rankRangeOf(game.ranks, i + 1)?.points ?? 0} 点`,
                  pts(rankRangeOf(game.ranks, i + 1)?.points ?? 0),
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** 投票で、票の多い順に順位・票数・点数と、投票した人 */
function VoteAnswers(props: { game: GameDto; answers: GameAnswersResponse["answers"] }) {
  const t = useT();
  const votes = props.answers.filter((a): a is typeof a & { targetUserId: string } => a.targetUserId !== undefined);
  if (votes.length === 0) return <p className="muted small">{t("まだ投票がありません。", "No votes yet.")}</p>;
  const results = tallyVotes(
    votes.map((a) => a.targetUserId),
    props.game.ranks,
  );
  const unknown = t("（不明なユーザ）", "(unknown user)");
  return (
    <>
      <p className="small">
        {t(`投票 ${votes.length} 人`, `${votes.length} voted`)}
        {props.game.voterPoints > 0 &&
          t(`（投票した人に ${props.game.voterPoints} 点）`, ` (${pts(props.game.voterPoints)} to each voter)`)}
      </p>
      <table className="game-number-answers">
        <thead>
          <tr>
            <th>{t("順位", "Rank")}</th>
            <th>{t("選ばれた人", "Voted for")}</th>
            <th>{t("票", "Votes")}</th>
            <th>{t("点数", "Points")}</th>
            <th>{t("投票した人", "Voters")}</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const voters = votes.filter((a) => a.targetUserId === r.userId);
            return (
              <tr key={r.userId}>
                <td className="num">{t(`${r.rank} 位`, ordinal(r.rank))}</td>
                <td>{voters[0]?.targetDisplayName ?? unknown}</td>
                <td className="num">{r.votes}</td>
                <td className="num">{t(`${r.points} 点`, pts(r.points))}</td>
                <td className="game-voters small">{voters.map((a) => a.displayName ?? unknown).join(t("、", ", "))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

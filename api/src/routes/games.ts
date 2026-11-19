import {
  type CurrentGameResponse,
  formatDisplayName,
  GAME_FORMAT_RULES,
  type GameRequest,
  type GameResultDto,
  type GameResultsResponse,
  gameAnswerRequestSchema,
  gameConfirmProblem,
  gameRequestSchema,
  hasGameAnswers,
  type RoundResponse,
  type RoundsResponse,
  roundOrderRequestSchema,
  roundRequestSchema,
  shuffle,
} from "@partally/shared";
import type { Context, Hono } from "hono";
import { toCurrentGameDto, toGameDto, toRoundDto } from "../dto.js";
import { type Env, fail, parseBody } from "../http.js";
import {
  GameAlreadyOpenError,
  type GameChoice,
  type GameRank,
  type GameRecord,
  type GameSlot,
  InvalidStateError,
  NotFoundError,
  type RoundRecord,
} from "../repository.js";
import { gameResults, isKeywordCorrect } from "../scoring.js";
import type { AppContext } from "./context.js";

const GAME_CONFLICT_MESSAGE = "ほかの画面でこのゲームが変更されました。開き直してから直してください";

/** 数値予想の点数の範囲を、順位の小さい順に */
function sortRanks(ranks: GameRank[]): GameRank[] {
  return [...ranks].sort((a, b) => a.from - b.from).map(({ from, to, points }) => ({ from, to, points }));
}

export function registerGameRoutes(app: Hono<Env>, ctx: AppContext) {
  const {
    repo,
    now,
    rand,
    newId,
    settle,
    imageUrlOf,
    gamesWithAnswers,
    requireUser,
    removeImages,
    createImageUpload,
    attachImages,
  } = ctx;

  // 参加者の画面が数秒ごとに呼ぶので、読み込みは最小限にする（開催中の印・ゲーム・自分の答えだけ）
  app.get("/game/current", requireUser, async (c) => {
    const state = await repo.getOpenState();
    const userId = c.get("user").userId;
    const [round, games] = await Promise.all([
      state?.roundId ? repo.getRound(state.roundId) : undefined,
      Promise.all((state?.gameIds ?? []).map((id) => repo.getGame(id))),
    ]);
    const open = games.filter((g): g is GameRecord => g?.status === "open");
    // 1 問なら自分の答えを 1 件だけ読み、ラウンドなら自分の答えをまとめて 1 回で読む（数秒ごとに呼ばれるため）
    const answers =
      open.length > 1 ? new Map((await repo.listGameAnswersByUser(userId)).map((a) => [a.gameId, a])) : undefined;
    const dtos = await Promise.all(
      open.map(async (game) => {
        if (!hasGameAnswers(game)) return toCurrentGameDto(game, undefined, imageUrlOf);
        const answer = answers ? answers.get(game.gameId) : await repo.getGameAnswer(userId, game.gameId);
        return toCurrentGameDto(game, answer, imageUrlOf);
      }),
    );
    return c.json({
      game: dtos[0] ?? null,
      games: dtos,
      ...(round && dtos.length > 0 ? { round: { roundId: round.roundId, name: round.name } } : {}),
    } satisfies CurrentGameResponse);
  });

  app.put("/game/:gameId/answer", requireUser, async (c) => {
    const body = await parseBody(c, gameAnswerRequestSchema);
    if (!body.ok) return body.response;
    const game = await repo.getGame(c.req.param("gameId") ?? "");
    if (!game) return fail(c, 404, "not_found");
    const { choiceId, value, targetUserId, text, entry } = body.data;
    const userId = c.get("user").userId;
    // 形式ごとに決まった項目で答える（形式に合わない答えや、結果入力への答えは受け付けない）
    const field = GAME_FORMAT_RULES[game.format].answerField;
    const fits = field !== undefined && body.data[field] !== undefined;
    if (!fits) return fail(c, 400, "bad_request", "このゲームには、その形では答えられません");
    if (game.status !== "open") return fail(c, 409, "game_closed");
    if (choiceId !== undefined && !game.choices.some((ch) => ch.choiceId === choiceId)) {
      return fail(c, 400, "bad_request", "選択肢がありません");
    }
    if (targetUserId !== undefined) {
      if (targetUserId === userId) return fail(c, 400, "bad_request", "自分には投票できません");
      const target = await repo.getUser(targetUserId);
      if (target?.status !== "active") return fail(c, 400, "bad_request", "その人には投票できません");
    }
    if (text !== undefined) {
      // 合言葉は正解したときだけ保存する（不正解は何度でも試せる）。正解した後は、最初に正解した時刻のまま
      // 続けて送られても先の正解の時刻を上書きしないよう、強い整合性で読み、読んだときのままなら保存する
      const correct = isKeywordCorrect(game, text);
      const existing = await repo.getGameAnswer(userId, game.gameId, { consistent: true });
      if (!correct || isKeywordCorrect(game, existing?.text)) {
        return c.json({ game: toCurrentGameDto(game, existing, imageUrlOf), correct });
      }
      const answer = { gameId: game.gameId, userId, text, answeredAt: now().toISOString() };
      try {
        await repo.putGameAnswer(answer, { answeredAt: existing?.answeredAt });
      } catch (e) {
        if (!(e instanceof InvalidStateError)) throw e;
        // 同時に送られた別の答えが先に保存された（その答えのまま返す）
        const saved = await repo.getGameAnswer(userId, game.gameId, { consistent: true });
        return c.json({ game: toCurrentGameDto(game, saved, imageUrlOf), correct });
      }
      return c.json({ game: toCurrentGameDto(game, answer, imageUrlOf), correct: true });
    }
    // 答えは「決定」で 1 回だけ（答え直せない）。既に答えていれば 409 にし、先の答えのまま
    // 時刻は開催中を確かめた後に付ける。この後に終了されて保存が遅れた答えは、点数の計算で除かれる
    const answer = {
      gameId: game.gameId,
      userId,
      choiceId,
      value,
      targetUserId,
      text,
      entry,
      answeredAt: now().toISOString(),
    };
    try {
      await repo.putGameAnswer(answer, { answeredAt: undefined });
    } catch (e) {
      if (!(e instanceof InvalidStateError)) throw e;
      return fail(c, 409, "already_answered");
    }
    return c.json({
      game: toCurrentGameDto(game, answer, imageUrlOf),
      ...(text !== undefined ? { correct: true } : {}),
    });
  });

  // 終了したゲームの結果（設定で見せるときだけ。見せないときは空にする）
  app.get("/game-results", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.gameResultsVisible) return c.json({ games: [] } satisfies GameResultsResponse);
    const me = c.get("user").userId;
    const [entries, end, users] = await Promise.all([gamesWithAnswers(), repo.getEventEnd(), repo.listUsers()]);
    const names = new Map(users.map((u) => [u.userId, formatDisplayName(u.epithet, u.name)]));
    const nameOf = (userId: string) => names.get(userId) ?? "?";
    const games: GameResultDto[] = gameResults(entries, end?.endedAt).map(({ game, uncounted, answers, awards }) => {
      const mine = answers.find((a) => a.userId === me);
      const myAward = awards.find((a) => a.userId === me && a.slotName !== "投票");
      // 結果: 結果入力は枠ごと（枠の順）、ほかは点数が入った順位ごと（点数の高い順）。投票した人の点数は除く
      const groups = new Map<string, { label: string; names: string[]; points: number }>();
      const shown =
        game.format === "result"
          ? awards
          : game.format === "quiz"
            ? []
            : awards.filter((a) => a.points > 0 && a.slotName !== "投票");
      for (const a of shown) {
        const group = groups.get(a.slotName) ?? { label: a.slotName, names: [], points: a.points };
        group.names.push(nameOf(a.userId));
        groups.set(a.slotName, group);
      }
      const winners = [...groups.values()];
      if (game.format !== "result") winners.sort((a, b) => b.points - a.points);
      const top = Math.max(0, ...game.choices.map((ch) => ch.points));
      const correctChoices = top > 0 ? game.choices.filter((ch) => ch.points === top) : [];
      const correct =
        game.format === "quiz"
          ? correctChoices.map((ch) => ch.text).join("・") || undefined
          : game.format === "number"
            ? game.correctNumber?.toString()
            : game.format === "keyword"
              ? game.keyword
              : undefined;
      const myAnswer =
        mine === undefined
          ? undefined
          : game.format === "quiz"
            ? game.choices.find((ch) => ch.choiceId === mine.choiceId)?.text
            : game.format === "number"
              ? mine.value?.toString()
              : game.format === "vote"
                ? mine.targetUserId && nameOf(mine.targetUserId)
                : game.format === "keyword"
                  ? mine.text
                  : undefined;
      return {
        gameId: game.gameId,
        name: game.name,
        format: game.format,
        confirmedAt: game.confirmedAt,
        ...(uncounted ? { uncounted } : {}),
        answered: mine !== undefined,
        ...(correct !== undefined ? { correct } : {}),
        ...(myAnswer !== undefined ? { myAnswer } : {}),
        ...(game.format === "quiz" && mine && correctChoices.length > 0
          ? { myCorrect: correctChoices.some((ch) => ch.choiceId === mine.choiceId) }
          : {}),
        ...(myAward && game.format !== "quiz" ? { myResult: myAward.slotName } : {}),
        winners: winners.map(({ label, names }) => ({ label, names })),
      };
    });
    return c.json({ games } satisfies GameResultsResponse);
  });

  // 投票で選べる人（自分と、紐づけを解除した人を除く）。ゲームの画面を開いたときに 1 回だけ読む
  app.get("/game/:gameId/candidates", requireUser, async (c) => {
    const game = await repo.getGame(c.req.param("gameId") ?? "");
    if (!game) return fail(c, 404, "not_found");
    if (game.format !== "vote") return fail(c, 400, "bad_request", "投票のゲームではありません");
    if (game.status !== "open") return fail(c, 409, "game_closed");
    const me = c.get("user").userId;
    const candidates = (await repo.listUsers())
      .filter((u) => u.status === "active" && u.userId !== me)
      .sort((a, b) => a.name.localeCompare(b.name, "ja") || a.createdAt.localeCompare(b.createdAt))
      .map((u) => ({ userId: u.userId, displayName: formatDisplayName(u.epithet, u.name) }));
    return c.json({ candidates });
  });

  /** ゲームが使っている画像（問題と選択肢） */
  const gameImageIds = (game: Pick<GameRecord, "imageId" | "choices">) =>
    [game.imageId, ...game.choices.map((ch) => ch.imageId)].filter((id): id is string => id !== undefined);

  app.post("/admin/games/image-upload", createImageUpload);

  app.get("/admin/games", async (c) => {
    const entries = await gamesWithAnswers();
    const roundOf = roundIdsByGame(await repo.listRounds());
    return c.json({
      games: entries.map(({ game, answers }) => toGameDto(game, answers, imageUrlOf, roundOf.get(game.gameId))),
    });
  });

  /** クイズ形式の答えた人の一覧 */
  app.get("/admin/games/:gameId/answers", async (c) => {
    const game = await repo.getGame(c.req.param("gameId"));
    if (!game) return fail(c, 404, "not_found");
    const answers = await repo.listGameAnswersByGame(game.gameId);
    const ids = new Set(answers.flatMap((a) => (a.targetUserId ? [a.userId, a.targetUserId] : [a.userId])));
    const users = new Map((await repo.getUsers([...ids])).map((u) => [u.userId, u]));
    const nameOf = (userId: string | undefined) => {
      const user = userId === undefined ? undefined : users.get(userId);
      return user ? formatDisplayName(user.epithet, user.name) : undefined;
    };
    return c.json({
      game: toGameDto(game, answers, imageUrlOf, await roundIdOf(game.gameId)),
      answers: answers
        .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt))
        .map((a) => {
          return {
            userId: a.userId,
            displayName: nameOf(a.userId),
            choiceId: a.choiceId,
            value: a.value,
            targetUserId: a.targetUserId,
            targetDisplayName: nameOf(a.targetUserId),
            text: a.text,
            entry: a.entry,
            answeredAt: a.answeredAt,
          };
        }),
    });
  });

  /**
   * 送られた枠を保存する形にする。既存の枠の ID と、選んだ人が登録済みかを確かめる（問題があれば 400 のレスポンス）。
   * 紐づけを解除した人は新しくは選べない（選んだ後に解除された人は、そのまま残せる）
   */
  const gameSlotsOf = async (
    c: Context,
    slots: NonNullable<GameRequest["slots"]>,
    existing: GameSlot[] = [],
  ): Promise<GameSlot[] | Response> => {
    const existingIds = new Set(existing.map((s) => s.slotId));
    if (slots.some((s) => s.slotId !== undefined && !existingIds.has(s.slotId))) {
      return fail(c, 400, "bad_request", "存在しない枠があります");
    }
    const userIds = [...new Set(slots.flatMap((s) => s.userIds))];
    const found = await repo.getUsers(userIds);
    if (found.length !== userIds.length) return fail(c, 400, "bad_request", "登録されていない人が選ばれています");
    const current = new Set(existing.flatMap((s) => s.userIds));
    if (found.some((u) => u.status !== "active" && !current.has(u.userId))) {
      return fail(c, 400, "bad_request", "紐づけを解除した人は選べません");
    }
    return slots.map((s) => ({ slotId: s.slotId ?? newId(), name: s.name, points: s.points, userIds: s.userIds }));
  };

  /** 送られた選択肢を保存する形にする。既存の選択肢を直すときは choiceId を付けて送る（無い ID は 400） */
  const gameChoicesOf = (
    c: Context,
    choices: NonNullable<GameRequest["choices"]>,
    existing: GameChoice[] = [],
  ): GameChoice[] | Response => {
    const existingIds = new Set(existing.map((ch) => ch.choiceId));
    if (choices.some((ch) => ch.choiceId !== undefined && !existingIds.has(ch.choiceId))) {
      return fail(c, 400, "bad_request", "存在しない選択肢があります");
    }
    return choices.map((ch) => ({
      choiceId: ch.choiceId ?? newId(),
      text: ch.text,
      points: ch.points,
      imageId: ch.imageId,
    }));
  };

  app.post("/admin/games", async (c) => {
    const body = await parseBody(c, gameRequestSchema);
    if (!body.ok) return body.response;
    const slots = await gameSlotsOf(c, body.data.slots ?? []);
    if (slots instanceof Response) return slots;
    const choices = gameChoicesOf(c, body.data.choices ?? []);
    if (choices instanceof Response) return choices;
    const timestamp = now().toISOString();
    const game: GameRecord = {
      gameId: newId(),
      format: body.data.format,
      name: body.data.name,
      description: body.data.description ?? "",
      imageId: body.data.imageId,
      status: "draft",
      slots,
      choices,
      ranks: sortRanks(body.data.ranks ?? []),
      correctNumber: body.data.correctNumber,
      voterPoints: body.data.voterPoints ?? 0,
      keyword: body.data.keyword,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const images = await attachImages(c, gameImageIds(game));
    if (images.response) return images.response;
    try {
      await repo.createGame(game);
    } catch (e) {
      await removeImages(images.attached);
      throw e;
    }
    return c.json({ game: toGameDto(game, [], imageUrlOf) }, 201);
  });

  // 開催中・確定済みでも直せる（ポイントは直した内容で数え直し、推移では確定した時刻のまま）。
  // クイズの選択肢を増やす・減らすのは、答えと食い違わないよう、まだ答えが無い下書きの間だけ
  app.put("/admin/games/:gameId", async (c) => {
    const body = await parseBody(c, gameRequestSchema);
    if (!body.ok) return body.response;
    const game = await repo.getGame(c.req.param("gameId"));
    if (!game) return fail(c, 404, "not_found");
    if (body.data.format !== game.format) return fail(c, 400, "bad_request", "ゲームの形式は変えられません");
    if (body.data.baseUpdatedAt !== undefined && body.data.baseUpdatedAt !== game.updatedAt) {
      return fail(c, 409, "invalid_state", GAME_CONFLICT_MESSAGE);
    }
    const slots = await gameSlotsOf(c, body.data.slots ?? [], game.slots);
    if (slots instanceof Response) return slots;
    const choices = gameChoicesOf(c, body.data.choices ?? [], game.choices);
    if (choices instanceof Response) return choices;
    const sentIds = new Set((body.data.choices ?? []).flatMap((ch) => (ch.choiceId ? [ch.choiceId] : [])));
    const structureChanged =
      choices.length !== game.choices.length || game.choices.some((ch) => !sentIds.has(ch.choiceId));
    const answers = hasGameAnswers(game) ? await repo.listGameAnswersByGame(game.gameId) : [];
    if (structureChanged && (game.status !== "draft" || answers.length > 0)) {
      return fail(c, 409, "invalid_state", "答えがある・開催した後のクイズは、選択肢を増やしたり減らしたりできません");
    }
    // 確定したゲームから、確定に要るもの（結果入力の枠、正解の数、点数の範囲）を全部外すと、
    // 入ったポイントが黙って消えるので受け付けない（確定できない形には直せない）。
    // 以前の版で既に外してあるゲームは、名前などを直せるようにそのまま通す
    if (
      game.status === "confirmed" &&
      !gameConfirmProblem(game) &&
      gameConfirmProblem({
        format: game.format,
        slots,
        ranks: body.data.ranks ?? [],
        correctNumber: body.data.correctNumber,
      })
    ) {
      return fail(
        c,
        409,
        "invalid_state",
        "終了したゲームの枠・正解の数・点数の範囲は、全部は外せません。先に終了を取り消してください",
      );
    }
    const changes = {
      name: body.data.name,
      description: body.data.description ?? "",
      imageId: body.data.imageId,
      slots,
      choices,
      ranks: sortRanks(body.data.ranks ?? []),
      correctNumber: body.data.correctNumber,
      voterPoints: body.data.voterPoints ?? 0,
      keyword: body.data.keyword,
    };
    const before = gameImageIds(game);
    const after = gameImageIds(changes);
    const images = await attachImages(c, after, before);
    if (images.response) return images.response;
    try {
      const updated = await repo.updateGame(game.gameId, changes, now().toISOString(), body.data.baseUpdatedAt);
      // 差し替えた・外した画像は、保存できてから消す
      await removeImages(before.filter((id) => !after.includes(id)));
      return c.json({ game: toGameDto(updated, answers, imageUrlOf, await roundIdOf(updated.gameId)) });
    } catch (e) {
      // 保存できなかったら、新しく移した画像を消す
      await removeImages(images.attached);
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", GAME_CONFLICT_MESSAGE);
      throw e;
    }
  });

  /**
   * 参加者の一覧（GSI）は結果整合なので、締め切りの直前の参加がまだ出ていないことがある。抽選を締め切るとき（開催中だけ）は、
   * 一度読んでから少し待ってもう一度読み、どちらかに出た人を合わせる（抽選は確定のときの順番を保存し、後から直らないため）。
   * 確定の時刻は 2 回目の読み取りの直前に決めるので、待っている間の参加も数える
   */
  const readLotteryEntrants = async (game: GameRecord) => {
    const read = async () => (await repo.listGameAnswersByGame(game.gameId)).filter((a) => a.entry);
    const first = await read();
    await settle();
    const at = now().toISOString();
    const entrants = [...first, ...(await read())].filter((a) => a.answeredAt <= at).map((a) => a.userId);
    return { at, entrants: [...new Set(entrants)] };
  };

  /** 抽選の順番を決める。紐づけを解除した人（会場を離れた人）は除き、userId で並べてから並べ替える */
  const drawLottery = async (entrants: string[]) => {
    const active = (await repo.getUsers(entrants)).filter((u) => u.status === "active").map((u) => u.userId);
    return shuffle(active.sort(), rand);
  };

  /** 状態を変える。from は今の状態の前提（違えば 409） */
  const changeGameStatus = async (c: Context, game: GameRecord, to: GameRecord["status"], message: string) => {
    try {
      // 抽選は確定するときに、確定までに参加した人の順番を無作為に決めて保存する（確定し直すと引き直す）
      const lottery = to === "confirmed" && game.format === "lottery" ? await readLotteryEntrants(game) : undefined;
      const at = lottery?.at ?? now().toISOString();
      const drawOrder = lottery ? await drawLottery(lottery.entrants) : undefined;
      const updated = await repo.changeGameStatus(game.gameId, game.status, to, at, drawOrder);
      const answers = hasGameAnswers(updated) ? await repo.listGameAnswersByGame(updated.gameId) : [];
      return c.json({ game: toGameDto(updated, answers, imageUrlOf, await roundIdOf(updated.gameId)) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof GameAlreadyOpenError) {
        return fail(c, 409, "invalid_state", "別のゲームが開催中です。終了するか中断してから開始してください");
      }
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", message);
      throw e;
    }
  };

  /** ゲームが入っているラウンド */
  const roundIdOf = async (gameId: string) => roundIdsByGame(await repo.listRounds()).get(gameId);

  /** 状態の操作。allowed は操作できる今の状態 */
  const gameAction =
    (
      to: GameRecord["status"],
      allowed: GameRecord["status"][],
      message: string,
      check?: (game: GameRecord) => string | undefined,
    ) =>
    async (c: Context) => {
      const game = await repo.getGame(c.req.param("gameId") ?? "");
      if (!game) return fail(c, 404, "not_found");
      // ラウンドに入っているゲームは、ラウンドでまとめて開始・終了する
      if (await roundIdOf(game.gameId)) {
        return fail(c, 409, "invalid_state", "ラウンドに入っているゲームは、ラウンドで開始・終了してください");
      }
      if (!allowed.includes(game.status)) return fail(c, 409, "invalid_state", message);
      const problem = check?.(game);
      if (problem) return fail(c, 409, "invalid_state", problem);
      return changeGameStatus(c, game, to, message);
    };

  app.post("/admin/games/:gameId/open", gameAction("open", ["draft"], "開催できるのは下書きのゲームだけです"));
  app.post("/admin/games/:gameId/stop", gameAction("draft", ["open"], "開催中のゲームではありません"));
  // 入るポイントが決まらないゲーム（枠の無い結果入力、正解の数か点数の範囲が無い数値予想）は確定させない
  app.post(
    "/admin/games/:gameId/confirm",
    gameAction("confirmed", ["open"], "開催中のゲームだけ終了できます", gameConfirmProblem),
  );
  app.post("/admin/games/:gameId/unconfirm", gameAction("draft", ["confirmed"], "終了していません"));

  app.delete("/admin/games/:gameId", async (c) => {
    const game = await repo.getGame(c.req.param("gameId"));
    if (!game) return fail(c, 404, "not_found");
    try {
      await repo.deleteGame(game.gameId);
      await removeImages(gameImageIds(game));
      // 入っていたラウンドからも外す（下書きでないラウンドは出し入れできないので、直接書き換える）
      const round = (await repo.listRounds()).find((r) => r.gameIds.includes(game.gameId));
      if (round) await removeFromRound(round, game.gameId);
      return c.json({});
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) {
        return fail(c, 409, "invalid_state", "開催中のゲームは、開催をやめてから削除してください");
      }
      throw e;
    }
  });

  // ---- ラウンド（複数のゲームをまとめて開始・終了する） ----

  /** 入っていたラウンドからゲームを外す */
  const removeFromRound = (round: RoundRecord, gameId: string) =>
    repo.updateRound(round.roundId, { gameIds: round.gameIds.filter((id) => id !== gameId) }, now().toISOString(), {
      anyStatus: true,
    });

  /**
   * ラウンドに入れるゲームを確かめる（あるか・下書きか・ほかのラウンドに入っていないか）。問題があれば 400/409 のレスポンス
   */
  const checkRoundGames = async (c: Context, gameIds: string[], roundId?: string) => {
    const [games, rounds] = await Promise.all([repo.listGames(), repo.listRounds()]);
    const byId = new Map(games.map((g) => [g.gameId, g]));
    const current = rounds.find((r) => r.roundId === roundId);
    for (const id of gameIds) {
      const game = byId.get(id);
      if (!game) return fail(c, 400, "bad_request", "ゲームがありません");
      const other = rounds.find((r) => r.roundId !== roundId && r.gameIds.includes(id));
      if (other)
        return fail(c, 409, "invalid_state", `「${game.name}」は、ほかのラウンド（${other.name}）に入っています`);
      // 新しく入れるゲームは下書きだけ（開催中・終了済みの 1 問を入れると、ラウンドの状態と合わなくなる）
      if (!current?.gameIds.includes(id) && game.status !== "draft") {
        return fail(c, 409, "invalid_state", `「${game.name}」は下書きでないので、ラウンドに入れられません`);
      }
    }
    return undefined;
  };

  app.get("/admin/rounds", async (c) => {
    const rounds = await repo.listRounds();
    return c.json({ rounds: rounds.map(toRoundDto) } satisfies RoundsResponse);
  });

  app.post("/admin/rounds", async (c) => {
    const body = await parseBody(c, roundRequestSchema);
    if (!body.ok) return body.response;
    const problem = await checkRoundGames(c, body.data.gameIds);
    if (problem) return problem;
    const rounds = await repo.listRounds();
    const at = now().toISOString();
    const round: RoundRecord = {
      roundId: newId(),
      name: body.data.name,
      gameIds: body.data.gameIds,
      status: "draft",
      // 後ろに足す
      position: Math.max(0, ...rounds.map((r) => r.position + 1)),
      createdAt: at,
      updatedAt: at,
    };
    await repo.createRound(round);
    return c.json({ round: toRoundDto(round) } satisfies RoundResponse, 201);
  });

  app.put("/admin/rounds/order", async (c) => {
    const body = await parseBody(c, roundOrderRequestSchema);
    if (!body.ok) return body.response;
    const rounds = await repo.listRounds();
    const ids = body.data.roundIds;
    if (
      ids.length !== rounds.length ||
      new Set(ids).size !== ids.length ||
      !rounds.every((r) => ids.includes(r.roundId))
    ) {
      return fail(c, 400, "bad_request", "すべてのラウンドを 1 回ずつ並べてください");
    }
    const at = now().toISOString();
    for (const [position, roundId] of ids.entries()) {
      const round = rounds.find((r) => r.roundId === roundId)!;
      if (round.position !== position) await repo.updateRound(roundId, { position }, at);
    }
    return c.json({ rounds: (await repo.listRounds()).map(toRoundDto) } satisfies RoundsResponse);
  });

  app.put("/admin/rounds/:roundId", async (c) => {
    const body = await parseBody(c, roundRequestSchema);
    if (!body.ok) return body.response;
    const round = await repo.getRound(c.req.param("roundId"));
    if (!round) return fail(c, 404, "not_found");
    const sameGames = JSON.stringify(round.gameIds) === JSON.stringify(body.data.gameIds);
    if (!sameGames) {
      if (round.status !== "draft") {
        return fail(
          c,
          409,
          "invalid_state",
          "開始中・終了済みのラウンドは、ゲームを出し入れできません（名前は直せます）",
        );
      }
      const problem = await checkRoundGames(c, body.data.gameIds, round.roundId);
      if (problem) return problem;
    }
    try {
      const updated = await repo.updateRound(
        round.roundId,
        { name: body.data.name, ...(sameGames ? {} : { gameIds: body.data.gameIds }) },
        now().toISOString(),
      );
      return c.json({ round: toRoundDto(updated) } satisfies RoundResponse);
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", "ラウンドの状態が変わりました");
      throw e;
    }
  });

  app.delete("/admin/rounds/:roundId", async (c) => {
    try {
      // ラウンドだけを消す（中のゲームは残り、1 問ずつ開始・終了できるようになる）
      await repo.deleteRound(c.req.param("roundId"));
      return c.json({});
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError)
        return fail(c, 409, "invalid_state", "開始中のラウンドは、中断してから削除してください");
      throw e;
    }
  });

  /** ラウンドと中のゲームの状態をまとめて変える */
  const roundAction =
    (to: GameRecord["status"], allowed: GameRecord["status"][], message: string) => async (c: Context) => {
      const round = await repo.getRound(c.req.param("roundId") ?? "");
      if (!round) return fail(c, 404, "not_found");
      if (!allowed.includes(round.status)) return fail(c, 409, "invalid_state", message);
      if (round.gameIds.length === 0) return fail(c, 409, "invalid_state", "ラウンドにゲームが入っていません");
      const games = (await Promise.all(round.gameIds.map((id) => repo.getGame(id)))).filter(
        (g): g is GameRecord => g !== undefined,
      );
      if (to === "confirmed") {
        // 終了できない問題があれば、まとめて知らせる
        const problems = games.flatMap((g) => {
          const problem = gameConfirmProblem(g);
          return problem ? [`「${g.name}」: ${problem}`] : [];
        });
        if (problems.length > 0) return fail(c, 409, "invalid_state", problems.join("\n"));
      }
      try {
        // 抽選は、終了までに参加した人を少し待って 2 回読み（1 回だけ待つ）、順番を決める
        const lotteries = to === "confirmed" ? games.filter((g) => g.format === "lottery") : [];
        const entryOf = async (g: GameRecord) => (await repo.listGameAnswersByGame(g.gameId)).filter((a) => a.entry);
        const first = await Promise.all(lotteries.map(entryOf));
        if (lotteries.length > 0) await settle();
        const at = now().toISOString();
        const second = await Promise.all(lotteries.map(entryOf));
        const drawOrders: Record<string, string[]> = {};
        for (const [i, game] of lotteries.entries()) {
          const entrants = [...first[i]!, ...second[i]!].filter((a) => a.answeredAt <= at).map((a) => a.userId);
          drawOrders[game.gameId] = await drawLottery([...new Set(entrants)]);
        }
        const updated = await repo.changeRoundStatus(round, round.status, to, at, drawOrders);
        return c.json({ round: toRoundDto(updated) } satisfies RoundResponse);
      } catch (e) {
        if (e instanceof NotFoundError) return fail(c, 404, "not_found");
        if (e instanceof GameAlreadyOpenError) {
          return fail(
            c,
            409,
            "invalid_state",
            "ほかのゲームかラウンドが開催中です。終了するか中断してから開始してください",
          );
        }
        if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", message);
        throw e;
      }
    };

  app.post("/admin/rounds/:roundId/open", roundAction("open", ["draft"], "開始できるのは下書きのラウンドだけです"));
  app.post("/admin/rounds/:roundId/stop", roundAction("draft", ["open"], "開始中のラウンドではありません"));
  app.post("/admin/rounds/:roundId/confirm", roundAction("confirmed", ["open"], "開始中のラウンドだけ終了できます"));
  app.post("/admin/rounds/:roundId/unconfirm", roundAction("draft", ["confirmed"], "終了していません"));
}

/** ゲームごとの、入っているラウンド */
function roundIdsByGame(rounds: RoundRecord[]): Map<string, string> {
  return new Map(rounds.flatMap((r) => r.gameIds.map((id) => [id, r.roundId] as const)));
}

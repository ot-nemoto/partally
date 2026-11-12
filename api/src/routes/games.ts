import {
  formatDisplayName,
  GAME_FORMAT_RULES,
  type GameRequest,
  gameAnswerRequestSchema,
  gameConfirmProblem,
  gameRequestSchema,
  hasGameAnswers,
  shuffle,
} from "@partally/shared";
import type { Context, Hono } from "hono";
import { toCurrentGameDto, toGameDto } from "../dto.js";
import { type Env, fail, parseBody } from "../http.js";
import {
  GameAlreadyOpenError,
  type GameChoice,
  type GameRank,
  type GameRecord,
  type GameSlot,
  InvalidStateError,
  NotFoundError,
} from "../repository.js";
import { isKeywordCorrect } from "../scoring.js";
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

  // 参加者の画面が数秒ごとに呼ぶので、読み込みは最小限にする
  app.get("/game/current", requireUser, async (c) => {
    const gameId = await repo.getOpenGameId();
    const game = gameId ? await repo.getGame(gameId) : undefined;
    if (game?.status !== "open") return c.json({ game: null });
    const answer = hasGameAnswers(game) ? await repo.getGameAnswer(c.get("user").userId, game.gameId) : undefined;
    return c.json({ game: toCurrentGameDto(game, answer, imageUrlOf) });
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
    // 時刻は開催中を確かめた後に付ける。この後に確定されて保存が遅れた答えは、点数の計算で除かれる
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
    await repo.putGameAnswer(answer);
    return c.json({
      game: toCurrentGameDto(game, answer, imageUrlOf),
      ...(text !== undefined ? { correct: true } : {}),
    });
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
    return c.json({ games: entries.map(({ game, answers }) => toGameDto(game, answers, imageUrlOf)) });
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
      game: toGameDto(game, answers, imageUrlOf),
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
        "確定したゲームの枠・正解の数・点数の範囲は、全部は外せません。先に確定を取り消してください",
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
      return c.json({ game: toGameDto(updated, answers, imageUrlOf) });
    } catch (e) {
      // 保存できなかったら、新しく移した画像を消す
      await removeImages(images.attached);
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", GAME_CONFLICT_MESSAGE);
      throw e;
    }
  });

  /**
   * 参加者の一覧（GSI）は結果整合なので、確定の直前の参加がまだ出ていないことがある。開催中の抽選を確定するときは、
   * 一度読んでから少し待ってもう一度読み、どちらかに出た人を合わせる（抽選は確定のときの順番を保存し、後から直らないため）。
   * 確定の時刻は 2 回目の読み取りの直前に決めるので、待っている間の参加も数える
   */
  const readLotteryEntrants = async (game: GameRecord) => {
    const read = async () => (await repo.listGameAnswersByGame(game.gameId)).filter((a) => a.entry);
    // 下書きからの確定は、新しい参加が無い（開催中しか参加できない）ので待たない
    const first = game.status === "open" ? await read() : [];
    if (game.status === "open") await settle();
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
      return c.json({ game: toGameDto(updated, answers, imageUrlOf) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof GameAlreadyOpenError) {
        return fail(c, 409, "invalid_state", "別のゲームが開催中です。確定するか、開催をやめてから開催してください");
      }
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", message);
      throw e;
    }
  };

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
    gameAction("confirmed", ["draft", "open"], "既に確定しています", gameConfirmProblem),
  );
  app.post("/admin/games/:gameId/unconfirm", gameAction("draft", ["confirmed"], "確定していません"));

  app.delete("/admin/games/:gameId", async (c) => {
    const game = await repo.getGame(c.req.param("gameId"));
    if (!game) return fail(c, 404, "not_found");
    try {
      await repo.deleteGame(game.gameId);
      await removeImages(gameImageIds(game));
      return c.json({});
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) {
        return fail(c, 409, "invalid_state", "開催中のゲームは、開催をやめてから削除してください");
      }
      throw e;
    }
  });
}

import { describe, expect, it, vi } from "vitest";
import { prizeImageKey } from "./photo-storage.js";
import { DEFAULT_SETTINGS, InvalidStateError } from "./repository.js";
import { type Client, createClient, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("ゲーム（クイズ形式）", () => {
    let participantSeq = 0;
    const participant = (name: string) => t.register(name, [1, participantSeq++]);

    const me = async (request: Client) => (await request("GET", "/api/me")).body;

    async function createQuiz(admin: Client, points = [10, 0, 5]) {
      const res = await admin("POST", "/api/admin/games", {
        format: "quiz",
        name: "第 1 問",
        description: "  幹事の出身地は？\n（ヒント: 海がある）  ",
        choices: points.map((p, i) => ({ text: `選択肢${i + 1}`, points: p })),
      });
      expect(res.status).toBe(201);
      return res.body.game;
    }
    const choicesOf = (game: any) =>
      game.choices.map((ch: any) => ({ choiceId: ch.choiceId, text: ch.text, points: ch.points }));

    it("開催 → 答える（選び直し可）→ 確定で、選んだ選択肢の点数がポイントに加わる", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");
      const quiz = await createQuiz(admin);
      expect(quiz).toMatchObject({
        format: "quiz",
        status: "draft",
        description: "幹事の出身地は？\n（ヒント: 海がある）",
        answerCount: 0,
        slots: [],
      });
      const [c1, c2, c3] = quiz.choices.map((ch: any) => ch.choiceId);
      const answer = (who: typeof a, choiceId: string) =>
        who.request("PUT", `/api/game/${quiz.gameId}/answer`, { choiceId });

      // 下書きは参加者に見えず、答えられない
      expect((await a.request("GET", "/api/game/current")).body.game).toBeNull();
      expect((await answer(a, c1)).body.error).toBe("game_closed");

      expect((await admin("POST", `/api/admin/games/${quiz.gameId}/open`)).body.game.status).toBe("open");
      const current = (await a.request("GET", "/api/game/current")).body.game;
      expect(current).toEqual({
        gameId: quiz.gameId,
        format: "quiz",
        name: "第 1 問",
        description: quiz.description,
        // 正解がわからないよう、点数は返さない
        choices: quiz.choices.map((ch: any) => ({ choiceId: ch.choiceId, text: ch.text })),
      });

      expect((await answer(a, c1)).status).toBe(200);
      expect((await answer(a, c3)).body.game.myChoiceId).toBe(c3);
      await answer(b, c2);
      expect((await a.request("GET", "/api/game/current")).body.game.myChoiceId).toBe(c3);
      expect((await answer(a, "NOPE")).status).toBe(400);

      // 開催中は点数に数えない（選び直して正解を探れないように）
      expect((await me(a.request)).user).toMatchObject({ gamePoints: 0, points: 0, gameAwards: [] });

      const confirmed = await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);
      expect(confirmed.body.game).toMatchObject({ status: "confirmed", answerCount: 2 });
      // 確定の直前に受け付けて確定より後に保存された答えは、点数と同じく回答数・選択肢ごとの人数にも数えない
      await t.repo.putGameAnswer({
        gameId: quiz.gameId,
        userId: a.userId,
        choiceId: c2,
        answeredAt: new Date(Date.parse(confirmed.body.game.confirmedAt) + 1).toISOString(),
      });
      const listed = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === quiz.gameId);
      expect(listed.answerCount).toBe(1);
      expect(listed.choices.map((ch: any) => ch.answerCount)).toEqual([0, 1, 0]);
      await t.repo.putGameAnswer({
        gameId: quiz.gameId,
        userId: a.userId,
        choiceId: c3,
        answeredAt: "2000-01-01T00:00:00.000Z",
      });
      expect((await a.request("GET", "/api/game/current")).body.game).toBeNull();
      expect((await answer(a, c1)).body.error).toBe("game_closed");
      expect((await me(a.request)).user).toMatchObject({
        gamePoints: 5,
        points: 5,
        gameAwards: [{ gameName: "第 1 問", slotName: "選択肢3", points: 5 }],
      });
      expect((await me(b.request)).user).toMatchObject({ gamePoints: 0, points: 0 });

      const results = (await admin("GET", `/api/admin/games/${quiz.gameId}/answers`)).body;
      expect(results.game.choices.map((ch: any) => [ch.points, ch.answerCount])).toEqual([
        [10, 0],
        [0, 1],
        [5, 1],
      ]);
      expect(results.answers.map((x: any) => [x.displayName.endsWith("田中"), x.choiceId])).toEqual([
        [true, c3],
        [false, c2],
      ]);
      const users = (await admin("GET", "/api/admin/users")).body.users;
      expect(users.map((u: any) => [u.name, u.gamePoints, u.points])).toEqual([
        ["田中", 5, 5],
        ["鈴木", 0, 0],
      ]);

      // 取り消すとポイントが消え、もう一度開催すれば答え直せる（前の答えは残る）
      expect((await admin("POST", `/api/admin/games/${quiz.gameId}/unconfirm`)).body.game.status).toBe("draft");
      expect((await me(a.request)).user.points).toBe(0);
      await admin("POST", `/api/admin/games/${quiz.gameId}/open`);
      expect((await a.request("GET", "/api/game/current")).body.game.myChoiceId).toBe(c3);
      await answer(a, c1);
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);
      expect((await me(a.request)).user.points).toBe(10);
    });

    /** 管理画面と同じく、アップロード URL をもらって画像を置く */
    async function uploadImage(admin: Client) {
      const res = await admin("POST", "/api/admin/games/image-upload", {});
      expect(res.status).toBe(200);
      t.storage.put(res.body.upload.fields.key, new Uint8Array([1, 2, 3]), "");
      return res.body.imageId as string;
    }
    const served = (imageId: string) => t.storage.get(prizeImageKey(imageId)) !== undefined;

    it("問題と選択肢に画像を付けられ、差し替え・外す・削除で古い画像を消す。参加者には署名付き URL で返す", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const q = await uploadImage(admin);
      const c1 = await uploadImage(admin);
      const created = await admin("POST", "/api/admin/games", {
        format: "quiz",
        name: "この人は誰？",
        imageId: q,
        choices: [
          { text: "A", points: 10, imageId: c1 },
          { text: "B", points: 0 },
        ],
      });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game.imageId).toBe(q);
      expect(game.imageUrl).toBe(`/prizes/${q}.jpg?signed`);
      expect(game.choices.map((ch: any) => ch.imageUrl)).toEqual([`/prizes/${c1}.jpg?signed`, undefined]);
      expect([served(q), served(c1)]).toEqual([true, true]);
      expect(t.storage.get(prizeImageKey(q, "uploads"))).toBeUndefined();

      // 参加者には開催中だけ、画像の URL も返す
      await admin("POST", `/api/admin/games/${game.gameId}/open`);
      const current = (await a.request("GET", "/api/game/current")).body.game;
      expect(current.imageUrl).toBe(`/prizes/${q}.jpg?signed`);
      expect(current.choices.map((ch: any) => ch.imageUrl)).toEqual([`/prizes/${c1}.jpg?signed`, undefined]);

      // 問題の画像を差し替え、選択肢 A の画像を外して B に付ける
      const q2 = await uploadImage(admin);
      const c2 = await uploadImage(admin);
      const [ch1, ch2] = game.choices;
      const updated = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "quiz",
        name: "この人は誰？",
        imageId: q2,
        choices: [
          { choiceId: ch1.choiceId, text: "A", points: 10 },
          { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
        ],
      });
      expect(updated.status).toBe(200);
      expect(updated.body.game.choices.map((ch: any) => ch.imageId)).toEqual([undefined, c2]);
      expect([served(q), served(c1), served(q2), served(c2)]).toEqual([false, false, true, true]);

      // アップロードしていない画像・ほかで使った画像は 400 で、何も変えない
      const bad = (imageId: string) =>
        admin("PUT", `/api/admin/games/${game.gameId}`, {
          format: "quiz",
          name: "この人は誰？",
          imageId,
          choices: [
            { choiceId: ch1.choiceId, text: "A", points: 10 },
            { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
          ],
        });
      expect((await bad("NOTUPLOADED")).status).toBe(400);
      expect((await bad(q)).status).toBe(400);
      expect(served(q2)).toBe(true);
      // 同じ画像を 2 か所には付けられない
      expect(
        (
          await admin("PUT", `/api/admin/games/${game.gameId}`, {
            format: "quiz",
            name: "この人は誰？",
            imageId: c2,
            choices: [
              { choiceId: ch1.choiceId, text: "A", points: 10 },
              { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
            ],
          })
        ).status,
      ).toBe(400);

      // 版が古ければ、新しい画像は移さずに 409（受け口に残り、1 日で消える）
      const q3 = await uploadImage(admin);
      const stale = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "quiz",
        name: "この人は誰？",
        imageId: q3,
        choices: [
          { choiceId: ch1.choiceId, text: "A", points: 10 },
          { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
        ],
        baseUpdatedAt: game.updatedAt,
      });
      expect(stale.status).toBe(409);
      expect(served(q3)).toBe(false);

      // 画像を移した後に保存が失敗したら（同時の変更で版の条件に合わないなど）、移した画像を消す
      const q4 = await uploadImage(admin);
      const spy = vi.spyOn(t.repo, "updateGame").mockRejectedValueOnce(new InvalidStateError());
      const failed = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "quiz",
        name: "この人は誰？",
        imageId: q4,
        choices: [
          { choiceId: ch1.choiceId, text: "A", points: 10 },
          { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
        ],
      });
      spy.mockRestore();
      expect(failed.status).toBe(409);
      expect([served(q4), served(q2), served(c2)]).toEqual([false, true, true]);

      // 削除すると画像も消す
      await admin("POST", `/api/admin/games/${game.gameId}/stop`);
      expect((await admin("DELETE", `/api/admin/games/${game.gameId}`)).status).toBe(200);
      expect([served(q2), served(c2)]).toEqual([false, false]);
    });

    it("ゲームを削除すると、画像は 1 枚ずつ待たずに並行して消す", async () => {
      const admin = await t.adminClient();
      const [q, c1, c2] = [await uploadImage(admin), await uploadImage(admin), await uploadImage(admin)];
      const created = await admin("POST", "/api/admin/games", {
        format: "quiz",
        name: "画像だらけ",
        imageId: q,
        choices: [
          { text: "A", points: 1, imageId: c1 },
          { text: "B", points: 0, imageId: c2 },
        ],
      });
      // 3 枚の削除がそろって始まるまで、どの削除も終わらない（1 枚ずつ待つと、ここで止まって時間切れになる）
      let started = 0;
      let release: () => void = () => {};
      const allStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = t.storage.removePrizeImage.bind(t.storage);
      const remove = vi.spyOn(t.storage, "removePrizeImage").mockImplementation(async (imageId) => {
        if (++started === 3) release();
        await allStarted;
        await original(imageId);
      });
      try {
        expect((await admin("DELETE", `/api/admin/games/${created.body.game.gameId}`)).status).toBe(200);
      } finally {
        remove.mockRestore();
      }
      expect(started).toBe(3);
      expect([served(q), served(c1), served(c2)]).toEqual([false, false, false]);
    });

    it("開催中にできるのは 1 つだけ（形式によらない）。やめる・確定で次を開催できる", async () => {
      const admin = await t.adminClient();
      const q1 = await createQuiz(admin);
      const q2 = await createQuiz(admin);
      const r1 = (await admin("POST", "/api/admin/games", { format: "result", name: "大会", slots: [] })).body.game;
      const post = (id: string, action: string) =>
        admin("POST", `/api/admin/games/${id}/${action}`).then((r) => r.status);
      expect(await post(q1.gameId, "open")).toBe(200);
      expect(await post(q2.gameId, "open")).toBe(409);
      expect(await post(r1.gameId, "open")).toBe(409);
      expect(await post(q2.gameId, "stop")).toBe(409);
      expect(await post(q1.gameId, "open")).toBe(409);
      expect(await post(q1.gameId, "stop")).toBe(200);
      expect(await post(r1.gameId, "open")).toBe(200);
      expect(await post(r1.gameId, "confirm")).toBe(409); // 枠が無い
      expect(await post(q2.gameId, "confirm")).toBe(200); // 下書きから直接確定もできる
      expect(await post(q2.gameId, "confirm")).toBe(409);
      expect(await post(q2.gameId, "unconfirm")).toBe(200);
      expect(await post(q2.gameId, "unconfirm")).toBe(409);
      // 開催中のゲームがあっても、無いゲームは 404
      expect(await post("NOPE", "open")).toBe(404);
      const list = (await admin("GET", "/api/admin/games")).body.games;
      expect(list.map((g: any) => [g.format, g.status])).toEqual([
        ["quiz", "draft"],
        ["quiz", "draft"],
        ["result", "open"],
      ]);
    });

    it("開催した後も文言と点数は直せて、点数を直すと数え直す。選択肢の増減は答えが無い下書きの間だけ", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      const [c1] = quiz.choices.map((ch: any) => ch.choiceId);
      const put = (body: Record<string, unknown>) =>
        admin("PUT", `/api/admin/games/${quiz.gameId}`, { format: "quiz", name: "第 1 問", ...body });

      // 下書きで答えが無いなら選択肢を増やせる
      const added = await put({ choices: [...choicesOf(quiz), { text: "選択肢4", points: 1 }] });
      expect(added.body.game.choices).toHaveLength(4);
      const kept = choicesOf(added.body.game);

      await admin("POST", `/api/admin/games/${quiz.gameId}/open`);
      await a.request("PUT", `/api/game/${quiz.gameId}/answer`, { choiceId: c1 });
      expect((await put({ choices: kept.slice(0, 3) })).status).toBe(409);
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);
      expect((await me(a.request)).user.points).toBe(10);
      // 答えがあれば、下書きに戻しても増減はできない
      await admin("POST", `/api/admin/games/${quiz.gameId}/unconfirm`);
      expect((await put({ choices: kept.slice(0, 3) })).status).toBe(409);
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);

      expect((await put({ choices: [...kept.slice(0, 3), { choiceId: "NOPE", text: "x", points: 0 }] })).status).toBe(
        400,
      );
      expect((await put({ choices: [kept[0], kept[0], kept[1], kept[2]] })).status).toBe(400);
      expect((await put({ format: "result", choices: [], slots: [] })).status).toBe(400);

      const rescored = await put({
        description: "直した問題文",
        choices: kept.map((ch: any) => (ch.choiceId === c1 ? { ...ch, text: "直した選択肢", points: 3 } : ch)),
      });
      expect(rescored.status).toBe(200);
      expect(rescored.body.game).toMatchObject({ description: "直した問題文", status: "confirmed" });
      expect((await me(a.request)).user).toMatchObject({
        gamePoints: 3,
        points: 3,
        gameAwards: [{ gameName: "第 1 問", slotName: "直した選択肢", points: 3 }],
      });
    });

    it("開催中は削除できず、確定したゲームを削除すると答えと点数も消える", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      await admin("POST", `/api/admin/games/${quiz.gameId}/open`);
      await a.request("PUT", `/api/game/${quiz.gameId}/answer`, { choiceId: quiz.choices[0].choiceId });
      expect((await admin("DELETE", `/api/admin/games/${quiz.gameId}`)).status).toBe(409);
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);
      expect((await me(a.request)).user.points).toBe(10);

      expect((await admin("DELETE", `/api/admin/games/${quiz.gameId}`)).status).toBe(200);
      expect((await me(a.request)).user).toMatchObject({ gamePoints: 0, points: 0 });
      expect((await admin("GET", "/api/admin/games")).body.games).toEqual([]);
      expect(await t.repo.listGameAnswersByUser(a.userId)).toEqual([]);
      expect((await admin("DELETE", `/api/admin/games/${quiz.gameId}`)).status).toBe(404);
    });

    it("ゲームの点数は写真のポイントとは別に伏せられる", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      await admin("POST", `/api/admin/games/${quiz.gameId}/open`);
      await a.request("PUT", `/api/game/${quiz.gameId}/answer`, { choiceId: quiz.choices[0].choiceId });
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);

      // ゲームの点数だけを伏せる。合計のポイント（ゲームの分を含む）は見える
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showGamePoints: false });
      let user = (await me(a.request)).user;
      expect(user).not.toHaveProperty("gamePoints");
      expect(user).not.toHaveProperty("gameAwards");
      expect(user.points).toBe(10);

      // 写真のポイントだけを伏せる。ゲームの点数は見える
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showPoints: false });
      user = (await me(a.request)).user;
      expect(user).not.toHaveProperty("points");
      expect(user.gamePoints).toBe(10);
    });

    it("入力の検証とログインの確認", async () => {
      const admin = await t.adminClient();
      const bad = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/games", { format: "quiz", name: "問題", ...body }).then((r) => r.status);
      const two = [
        { text: "a", points: 1 },
        { text: "b", points: 0 },
      ];
      expect(await bad({ choices: [{ text: "1つだけ", points: 1 }] })).toBe(400);
      expect(await bad({ choices: [] })).toBe(400);
      expect(await bad({ name: " ", choices: two })).toBe(400);
      expect(await bad({ choices: [{ text: "a", points: 101 }, two[1]] })).toBe(400);
      expect(await bad({ choices: [{ choiceId: "X", text: "a", points: 1 }, two[1]] })).toBe(400);
      expect(await bad({ choices: two, slots: [{ name: "優勝", points: 1, userIds: [] }] })).toBe(400);
      expect(await bad({ format: "result", choices: two })).toBe(400);
      expect(await bad({ format: "other", choices: two })).toBe(400);
      expect(await bad({ choices: two, description: "x".repeat(501) })).toBe(400);
      // 結果入力のゲームには答えられない
      const result = (await admin("POST", "/api/admin/games", { format: "result", name: "大会" })).body.game;
      await admin("POST", `/api/admin/games/${result.gameId}/open`);
      const a = await participant("田中");
      // 結果入力の枠と点数は参加者に返さない
      expect((await a.request("GET", "/api/game/current")).body.game).not.toHaveProperty("slots");
      expect((await a.request("PUT", `/api/game/${result.gameId}/answer`, { choiceId: "X" })).status).toBe(400);
      expect((await createClient(t.app)("GET", "/api/game/current")).status).toBe(401);
      expect((await createClient(t.app)("GET", "/api/admin/games")).status).toBe(401);
    });
  });
});

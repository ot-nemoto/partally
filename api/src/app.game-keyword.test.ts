import { describe, expect, it, vi } from "vitest";
import { type Client, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("ゲーム（合言葉）", () => {
    let participantSeq = 0;
    const participant = (name: string) => t.register(name, [4, participantSeq++]);

    const me = async (request: Client) => (await request("GET", "/api/me")).body.user;
    const ranks = [
      { from: 1, to: 1, points: 20 },
      { from: 2, to: 3, points: 5 },
    ];

    it("開催 → 合言葉を入れる（不正解は何度でも、正解は先着順）→ 確定で、正解した順の点数が入る", async () => {
      const admin = await t.adminClient();
      const created = await admin("POST", "/api/admin/games", {
        format: "keyword",
        name: "宝探し",
        keyword: " パーティー ",
        ranks,
      });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game).toMatchObject({ format: "keyword", keyword: "パーティー", ranks });

      const people: Awaited<ReturnType<typeof participant>>[] = [];
      for (const n of ["A", "B", "C", "D", "E"]) people.push(await participant(n));
      const send = (who: (typeof people)[number], text: string) =>
        who.request("PUT", `/api/game/${game.gameId}/answer`, { text });
      expect((await send(people[0]!, "パーティー")).body.error).toBe("game_closed");

      expect((await admin("POST", `/api/admin/games/${game.gameId}/open`)).status).toBe(200);
      const current = (await people[0]!.request("GET", "/api/game/current")).body.game;
      expect(current).toMatchObject({ format: "keyword", myKeywordCorrect: false });
      expect(current).not.toHaveProperty("ranks");
      // 合言葉は参加者に返さない
      expect(JSON.stringify(current)).not.toContain("パーティー");

      // 不正解は保存せず、何度でも試せる
      const wrong = await send(people[0]!, "ぱーちー");
      expect(wrong.status).toBe(200);
      expect(wrong.body).toMatchObject({ correct: false, game: { myKeywordCorrect: false } });
      expect((await people[0]!.request("PUT", `/api/game/${game.gameId}/answer`, { value: 1 })).status).toBe(400);
      expect((await people[0]!.request("PUT", `/api/game/${game.gameId}/answer`, { text: "  " })).status).toBe(400);

      // 正解した順は時刻で決まるので、1 秒ずつ進める
      let now = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const tick = () => {
          now += 1000;
          vi.setSystemTime(now);
        };
        // 表記の揺れは同じ言葉として扱う。正解の順: B, A, D, C（E は不正解のまま）
        tick();
        expect((await send(people[1]!, "ﾊﾟｰﾃｨｰ")).body).toMatchObject({
          correct: true,
          game: { myKeywordCorrect: true },
        });
        tick();
        await send(people[0]!, "ぱーてぃー");
        tick();
        await send(people[3]!, "パー ティー");
        tick();
        await send(people[2]!, "パーティー");
        await send(people[4]!, "違う");
        // 正解した後に送っても、最初に正解した時刻のまま
        tick();
        expect((await send(people[1]!, "パーティー")).body.correct).toBe(true);
        expect((await send(people[1]!, "違う")).body).toMatchObject({
          correct: false,
          game: { myKeywordCorrect: true },
        });
        expect((await people[1]!.request("GET", "/api/game/current")).body.game.myKeywordCorrect).toBe(true);
        expect((await me(people[1]!.request)).gamePoints).toBe(0);

        const answers = (await admin("GET", `/api/admin/games/${game.gameId}/answers`)).body.answers;
        expect(answers).toHaveLength(4);
        expect(answers[0]).toMatchObject({ userId: people[1]!.userId, text: "ﾊﾟｰﾃｨｰ" });

        tick();
        expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
      const pts = await Promise.all(people.map(async (p) => (await me(p.request)).gamePoints));
      expect(pts).toEqual([5, 20, 0, 5, 0]);
      expect((await me(people[1]!.request)).gameAwards).toEqual([
        expect.objectContaining({ gameName: "宝探し", slotName: "1 番目に正解", points: 20 }),
      ]);
      expect((await me(people[2]!.request)).gameAwards).toEqual([
        expect.objectContaining({ slotName: "4 番目に正解", points: 0 }),
      ]);

      // 確定後に合言葉を直すと、今の合言葉に合う答えだけで数え直す（B の「ﾊﾟｰﾃｨｰ」は全員同じ言葉なので変わらない）
      const latest = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      const base = { format: "keyword", name: "宝探し", baseUpdatedAt: latest.updatedAt };
      expect((await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, keyword: "違う" })).status).toBe(409);
      const changed = await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, keyword: "違う", ranks });
      expect(changed.status).toBe(200);
      expect(await Promise.all(people.map(async (p) => (await me(p.request)).gamePoints))).toEqual([0, 0, 0, 0, 0]);
      // 回答数（正解した人数）も、今の合言葉に合う人だけを数える。保存された答えは残っている（回答者の一覧は開ける）
      expect(changed.body.game).toMatchObject({ answerCount: 0, storedAnswerCount: 4 });
    });

    it("正解を続けて送っても、後から保存された方が先の正解の時刻を上書きしない", async () => {
      const admin = await t.adminClient();
      const game = (
        await admin("POST", "/api/admin/games", { format: "keyword", name: "二重送信", keyword: "かぎ", ranks })
      ).body.game;
      await admin("POST", `/api/admin/games/${game.gameId}/open`);
      const a = await participant("二度押す人");
      // 1 回目の保存の直前に、別の送信の正解が先に保存された
      const put = t.repo.putGameAnswer.bind(t.repo);
      const spy = vi.spyOn(t.repo, "putGameAnswer").mockImplementationOnce(async (answer, expected) => {
        await put({ ...answer, answeredAt: "2000-01-01T00:00:00.000Z" });
        return put(answer, expected);
      });
      try {
        const res = await a.request("PUT", `/api/game/${game.gameId}/answer`, { text: "カギ" });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ correct: true, game: { myKeywordCorrect: true } });
      } finally {
        spy.mockRestore();
      }
      // 先に保存された正解の時刻のまま
      expect((await t.repo.getGameAnswer(a.userId, game.gameId))?.answeredAt).toBe("2000-01-01T00:00:00.000Z");
    });

    it("入力の検証と、範囲が無いと確定できないこと", async () => {
      const admin = await t.adminClient();
      const bad = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/games", { format: "keyword", name: "合言葉", ...body }).then((r) => r.status);
      expect(await bad({})).toBe(400);
      expect(await bad({ keyword: " " })).toBe(400);
      expect(await bad({ keyword: "x".repeat(51) })).toBe(400);
      expect(await bad({ keyword: "a", correctNumber: 1 })).toBe(400);
      expect(
        await admin("POST", "/api/admin/games", { format: "number", name: "n", keyword: "a" }).then((r) => r.status),
      ).toBe(400);
      const game = (await admin("POST", "/api/admin/games", { format: "keyword", name: "合言葉", keyword: "a" })).body
        .game;
      const res = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("点数の範囲を追加してから確定してください");
    });
  });
});

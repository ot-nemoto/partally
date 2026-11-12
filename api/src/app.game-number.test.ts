import { describe, expect, it } from "vitest";
import { type Client, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("ゲーム（数値予想）", () => {
    let participantSeq = 0;
    const participant = (name: string) => t.register(name, [2, participantSeq++]);

    const me = async (request: Client) => (await request("GET", "/api/me")).body.user;
    const ranks = [
      { from: 3, to: 5, points: 3 },
      { from: 1, to: 2, points: 10 },
    ];

    it("開催 → 数を答える（答え直し可）→ 正解の数を入れて確定で、近い順の順位に応じた点数が入る", async () => {
      const admin = await t.adminClient();
      const created = await admin("POST", "/api/admin/games", {
        format: "number",
        name: "瓶の中の飴は何個？",
        ranks,
      });
      expect(created.status).toBe(201);
      const game = created.body.game;
      // 点数の範囲は順位の小さい順に並べ直す
      expect(game).toMatchObject({ format: "number", status: "draft", ranks: [ranks[1], ranks[0]], choices: [] });
      expect(game.correctNumber).toBeUndefined();

      // 二つ名の抽選を順に指定するので、一人ずつ登録する
      const people: Awaited<ReturnType<typeof participant>>[] = [];
      for (const n of ["A", "B", "C", "D", "E", "F", "G"]) people.push(await participant(n));
      const answer = (who: (typeof people)[number], body: unknown) =>
        who.request("PUT", `/api/game/${game.gameId}/answer`, body);
      expect((await answer(people[0]!, { value: 50 })).body.error).toBe("game_closed");

      expect((await admin("POST", `/api/admin/games/${game.gameId}/open`)).status).toBe(200);
      const current = (await people[0]!.request("GET", "/api/game/current")).body.game;
      expect(current).toMatchObject({ format: "number" });
      expect(current).not.toHaveProperty("ranks");
      // 正解の数は参加者に返さない
      expect(current).not.toHaveProperty("correctNumber");

      // 範囲の外・小数・選択肢での答えは受け付けない
      for (const body of [
        { value: -1 },
        { value: 101 },
        { value: 1.5 },
        { choiceId: "X" },
        {},
        { value: 1, choiceId: "X" },
      ]) {
        expect((await answer(people[0]!, body)).status).toBe(400);
      }
      // 正解 40 に対して: A 0 → 40, B 30 → 10, C 50 → 10, D 45 → 5, E 40 → 0, F 100 → 60, G 70 → 30
      const values = [0, 30, 50, 45, 40, 100, 70];
      expect((await answer(people[0]!, { value: 99 })).body.game.myValue).toBe(99);
      for (const [i, v] of values.entries()) expect((await answer(people[i]!, { value: v })).status).toBe(200);
      expect((await people[0]!.request("GET", "/api/game/current")).body.game.myValue).toBe(0);

      // 正解の数が無いうちは確定できない
      const noAnswer = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(noAnswer.status).toBe(409);
      expect(noAnswer.body.message).toBe("正解の数を入れてから確定してください");

      const list = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      const set = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "number",
        name: game.name,
        ranks,
        correctNumber: 40,
        baseUpdatedAt: list.updatedAt,
      });
      expect(set.status).toBe(200);
      expect(set.body.game.correctNumber).toBe(40);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);

      const answers = (await admin("GET", `/api/admin/games/${game.gameId}/answers`)).body.answers;
      expect(answers.map((x: any) => x.value).sort((x: number, y: number) => x - y)).toEqual(
        [...values].sort((x, y) => x - y),
      );

      // 順位: E 1 位, D 2 位, B・C 3 位（同じ距離は同じ順位）, G 5 位, A 6 位, F 7 位
      const pts = await Promise.all(people.map(async (p) => (await me(p.request)).gamePoints));
      expect(pts).toEqual([0, 3, 3, 10, 10, 0, 3]);
      expect((await me(people[1]!.request)).gameAwards).toEqual([
        expect.objectContaining({ gameName: game.name, slotName: "3 位（予想 30）", points: 3 }),
      ]);

      // 確定後に正解の数を直すと、ポイントも直る（正解 100 なら F が 1 位）
      const after = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "number",
        name: game.name,
        ranks,
        correctNumber: 100,
        baseUpdatedAt: after.updatedAt,
      });
      expect((await me(people[5]!.request)).gamePoints).toBe(10);
      expect((await me(people[0]!.request)).gamePoints).toBe(0);

      // 確定したまま正解の数や点数の範囲を外すと、入ったポイントが黙って消えるので受け付けない
      const latest = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      const base = { format: "number", name: game.name, baseUpdatedAt: latest.updatedAt };
      expect((await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, ranks })).status).toBe(409);
      expect((await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, correctNumber: 100 })).status).toBe(409);
      expect((await me(people[5]!.request)).gamePoints).toBe(10);
      // ランキングにも入る（全員の答えから順位を付ける）
      const ranking = (await admin("GET", "/api/admin/ranking")).body.ranking;
      const pointsByName = Object.fromEntries(ranking.map((e: any) => [e.name, e.points]));
      // 正解 100 との差: F 0, G 30, C 50, D 55, E 60, B 70, A 100 → 1〜2 位 10 点、3〜5 位 3 点
      expect(pointsByName).toEqual({ A: 0, B: 0, C: 3, D: 3, E: 3, F: 10, G: 10 });
    });

    it("点数の範囲が無いと確定できず、範囲の重なりや逆転は受け付けない", async () => {
      const admin = await t.adminClient();
      const bad = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/games", { format: "number", name: "数", ...body }).then((r) => r.status);
      expect(await bad({ ranks: [{ from: 3, to: 1, points: 1 }] })).toBe(400);
      expect(
        await bad({
          ranks: [
            { from: 1, to: 3, points: 5 },
            { from: 3, to: 5, points: 1 },
          ],
        }),
      ).toBe(400);
      expect(await bad({ ranks: [{ from: 0, to: 1, points: 1 }] })).toBe(400);
      expect(await bad({ correctNumber: 101 })).toBe(400);
      expect(await bad({ correctNumber: 1.5 })).toBe(400);
      expect(
        await bad({
          choices: [
            { text: "a", points: 1 },
            { text: "b", points: 0 },
          ],
        }),
      ).toBe(400);
      expect(await admin("POST", "/api/admin/games", { format: "quiz", name: "q", ranks }).then((r) => r.status)).toBe(
        400,
      );

      const game = (await admin("POST", "/api/admin/games", { format: "number", name: "数", correctNumber: 0 })).body
        .game;
      expect(game.correctNumber).toBe(0);
      const res = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("点数の範囲を追加してから確定してください");
    });
  });
});

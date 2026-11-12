import { describe, expect, it } from "vitest";
import { type Client, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("ゲーム（投票）", () => {
    let participantSeq = 0;
    const participant = (name: string) => t.register(name, [3, participantSeq++]);

    const me = async (request: Client) => (await request("GET", "/api/me")).body.user;
    const ranks = [
      { from: 1, to: 1, points: 30 },
      { from: 2, to: 3, points: 10 },
    ];

    it("開催 → 投票（選び直し可）→ 確定で、得票の順位に応じた点数と、投票した人の点数が入る", async () => {
      const admin = await t.adminClient();
      const created = await admin("POST", "/api/admin/games", { format: "vote", name: "MVP", ranks, voterPoints: 2 });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game).toMatchObject({ format: "vote", voterPoints: 2, ranks, choices: [], slots: [] });

      // 二つ名の抽選を順に指定するので、一人ずつ登録する
      const people: Awaited<ReturnType<typeof participant>>[] = [];
      for (const n of ["A", "B", "C", "D", "E"]) people.push(await participant(n));
      const [a, b, c, d, e] = people as [
        (typeof people)[0],
        (typeof people)[0],
        (typeof people)[0],
        (typeof people)[0],
        (typeof people)[0],
      ];
      const vote = (who: typeof a, targetUserId: string) =>
        who.request("PUT", `/api/game/${game.gameId}/answer`, { targetUserId });
      expect((await vote(a, b.userId)).body.error).toBe("game_closed");
      expect((await a.request("GET", `/api/game/${game.gameId}/candidates`)).status).toBe(409);

      // E は紐づけを解除する（候補に出ず、投票もできない）
      expect((await admin("POST", `/api/admin/users/${e.userId}/unbind`)).status).toBe(200);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/open`)).status).toBe(200);
      const current = (await a.request("GET", "/api/game/current")).body.game;
      expect(current).toMatchObject({ format: "vote" });
      // 何をしたら何点か（得票の順位の点数、投票した人の点数）は参加者に返さない
      expect(current).not.toHaveProperty("ranks");
      expect(current).not.toHaveProperty("voterPoints");
      expect(current.myTargetUserId).toBeUndefined();

      const candidates = (await a.request("GET", `/api/game/${game.gameId}/candidates`)).body.candidates;
      expect(candidates.map((x: any) => x.userId).sort()).toEqual([b.userId, c.userId, d.userId].sort());
      expect(candidates[0].displayName).toContain("B");

      // 自分・紐づけを解除した人・いない人・ほかの形の答えは受け付けない
      expect((await vote(a, a.userId)).status).toBe(400);
      expect((await vote(a, e.userId)).status).toBe(400);
      expect((await vote(a, "NOBODY")).status).toBe(400);
      expect((await a.request("PUT", `/api/game/${game.gameId}/answer`, { value: 1 })).status).toBe(400);

      // A → C から B に選び直す。B → C、C → B、D → A
      expect((await vote(a, c.userId)).body.game.myTargetUserId).toBe(c.userId);
      await vote(a, b.userId);
      await vote(b, c.userId);
      await vote(c, b.userId);
      await vote(d, a.userId);
      expect((await a.request("GET", "/api/game/current")).body.game.myTargetUserId).toBe(b.userId);
      // 開催中は数えない
      expect((await me(b.request)).gamePoints).toBe(0);

      const answers = (await admin("GET", `/api/admin/games/${game.gameId}/answers`)).body.answers;
      expect(answers.find((x: any) => x.userId === a.userId)).toMatchObject({ targetUserId: b.userId });
      expect(answers.find((x: any) => x.userId === a.userId).targetDisplayName).toContain("B");

      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);
      // B 2 票 1 位 30 点、C 1 票・A 1 票は 2 位 10 点。投票した 4 人に 2 点ずつ
      const pts = await Promise.all([a, b, c, d].map(async (p) => (await me(p.request)).gamePoints));
      expect(pts).toEqual([12, 32, 12, 2]);
      expect((await me(b.request)).gameAwards).toEqual([
        expect.objectContaining({ gameName: "MVP", slotName: "1 位（2 票）", points: 30 }),
        expect.objectContaining({ gameName: "MVP", slotName: "投票", points: 2 }),
      ]);
      // ランキングにも入る（D は投票していないが、選ばれた分は参加者の画面でも数える）
      const ranking = (await admin("GET", "/api/admin/ranking")).body.ranking;
      expect(Object.fromEntries(ranking.map((x: any) => [x.name, x.points]))).toMatchObject({
        A: 12,
        B: 32,
        C: 12,
        D: 2,
      });

      // 確定後に点数を直すと数え直す。範囲を全部外すのは受け付けない
      const latest = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      const base = { format: "vote", name: "MVP", baseUpdatedAt: latest.updatedAt };
      expect((await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, voterPoints: 2 })).status).toBe(409);
      expect(
        (await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, ranks: [{ from: 1, to: 2, points: 5 }] }))
          .status,
      ).toBe(200);
      expect(await Promise.all([a, b, c, d].map(async (p) => (await me(p.request)).gamePoints))).toEqual([5, 5, 5, 0]);
    });

    it("入力の検証と、範囲が無いと確定できないこと", async () => {
      const admin = await t.adminClient();
      const bad = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/games", { format: "vote", name: "投票", ...body }).then((r) => r.status);
      expect(await bad({ correctNumber: 1 })).toBe(400);
      expect(await bad({ voterPoints: 101 })).toBe(400);
      expect(await bad({ ranks: [{ from: 2, to: 1, points: 1 }] })).toBe(400);
      expect(
        await admin("POST", "/api/admin/games", { format: "quiz", name: "q", voterPoints: 1 }).then((r) => r.status),
      ).toBe(400);
      const game = (await admin("POST", "/api/admin/games", { format: "vote", name: "投票" })).body.game;
      expect(game.voterPoints).toBe(0);
      const res = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("点数の範囲を追加してから確定してください");
      const a = await participant("田中");
      expect((await a.request("GET", `/api/game/${game.gameId}/candidates`)).status).toBe(409);
      const quiz = (
        await admin("POST", "/api/admin/games", {
          format: "quiz",
          name: "q",
          choices: [
            { text: "a", points: 1 },
            { text: "b", points: 0 },
          ],
        })
      ).body.game;
      expect((await a.request("GET", `/api/game/${quiz.gameId}/candidates`)).status).toBe(400);
    });
  });
});

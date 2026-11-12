import { describe, expect, it, vi } from "vitest";
import { type Client, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("ゲーム（抽選）", () => {
    let participantSeq = 0;
    const participant = (name: string) => t.register(name, [5, participantSeq++]);

    const me = async (request: Client) => (await request("GET", "/api/me")).body.user;
    const ranks = [
      { from: 1, to: 1, points: 30 },
      { from: 2, to: 3, points: 10 },
    ];

    it("開催 → 参加 → 確定で順番を決めて保存し、範囲に入った人に点数が入る。取り消して確定し直すと引き直す", async () => {
      const admin = await t.adminClient();
      const created = await admin("POST", "/api/admin/games", { format: "lottery", name: "ラッキー賞", ranks });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game).toMatchObject({ format: "lottery", ranks });
      expect(game.drawOrder).toBeUndefined();

      const people: Awaited<ReturnType<typeof participant>>[] = [];
      for (const n of ["A", "B", "C", "D", "E"]) people.push(await participant(n));
      const enter = (who: (typeof people)[number]) =>
        who.request("PUT", `/api/game/${game.gameId}/answer`, { entry: true });
      expect((await enter(people[0]!)).body.error).toBe("game_closed");

      expect((await admin("POST", `/api/admin/games/${game.gameId}/open`)).status).toBe(200);
      const lotteryCurrent = (await people[0]!.request("GET", "/api/game/current")).body.game;
      expect(lotteryCurrent).toMatchObject({ format: "lottery", myEntry: false });
      // 何をしたら何点か（順番の範囲の点数）は参加者に返さない
      expect(lotteryCurrent).not.toHaveProperty("ranks");
      expect((await people[0]!.request("PUT", `/api/game/${game.gameId}/answer`, { entry: false })).status).toBe(400);
      expect((await people[0]!.request("PUT", `/api/game/${game.gameId}/answer`, { text: "x" })).status).toBe(400);
      // A〜D と E が参加（A は 2 回押す）。E は確定の前に紐づけを解除される（抽選に含めない）
      expect((await enter(people[0]!)).body.game.myEntry).toBe(true);
      await enter(people[0]!);
      for (const p of people.slice(1)) await enter(p);
      expect((await people[0]!.request("GET", "/api/game/current")).body.game.myEntry).toBe(true);
      expect((await admin("GET", "/api/admin/games")).body.games[0].answerCount).toBe(5);
      expect((await admin("POST", `/api/admin/users/${people[4]!.userId}/unbind`)).status).toBe(200);

      // 乱数を常に 0 にすると、参加者（userId 順の A, B, C, D）は B, C, D, A の順になる
      t.randomInts = [0, 0, 0, 0];
      const confirmed = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(confirmed.status).toBe(200);
      const [a, b, c, d, e] = people.map((p) => p.userId);
      expect(confirmed.body.game.drawOrder).toEqual([b, c, d, a]);
      // B は 1 等 30 点、C・D は 2〜3 等 10 点、A は外れ、E は抽選に含めない
      // E は紐づけを解除したので、点数は管理画面で見る
      const pts = async () => {
        const byId = new Map(
          (await admin("GET", "/api/admin/users")).body.users.map((u: any) => [u.userId, u.gamePoints]),
        );
        return people.map((p) => byId.get(p.userId));
      };
      expect(await pts()).toEqual([0, 30, 10, 10, 0]);
      expect((await me(people[2]!.request)).gameAwards).toEqual([
        expect.objectContaining({ gameName: "ラッキー賞", slotName: "2〜3 等に当選", points: 10 }),
      ]);
      expect((await me(people[1]!.request)).gameAwards[0].slotName).toBe("1 等に当選");
      expect(e).toBeDefined();

      // 範囲を直すと、保存した順番のまま数え直す
      const latest = (await admin("GET", "/api/admin/games")).body.games[0];
      const changed = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "lottery",
        name: "ラッキー賞",
        ranks: [{ from: 4, to: 4, points: 7 }],
        baseUpdatedAt: latest.updatedAt,
      });
      expect(changed.status).toBe(200);
      expect(changed.body.game.drawOrder).toEqual([b, c, d, a]);
      expect(await pts()).toEqual([7, 0, 0, 0, 0]);

      // 取り消すと順番も消え、確定し直すと引き直す（乱数を常に最大にすると userId 順のまま）
      const undone = await admin("POST", `/api/admin/games/${game.gameId}/unconfirm`);
      expect(undone.body.game.drawOrder).toBeUndefined();
      expect(await pts()).toEqual([0, 0, 0, 0, 0]);
      t.randomInts = [3, 2, 1];
      const again = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(again.body.game.drawOrder).toEqual([a, b, c, d]);
      expect(await pts()).toEqual([0, 0, 0, 7, 0]);
    });

    it("確定のとき、1 回目の読み取りに出なかった参加者（結果整合の遅れ）も抽選に入る", async () => {
      const admin = await t.adminClient();
      const game = (await admin("POST", "/api/admin/games", { format: "lottery", name: "駆け込み", ranks })).body.game;
      await admin("POST", `/api/admin/games/${game.gameId}/open`);
      const a = await participant("早い人");
      const b = await participant("駆け込み");
      for (const p of [a, b]) await p.request("PUT", `/api/game/${game.gameId}/answer`, { entry: true });
      // 1 回目の読み取りでは、駆け込みの人がまだ索引に出ていない
      const list = t.repo.listGameAnswersByGame.bind(t.repo);
      const spy = vi
        .spyOn(t.repo, "listGameAnswersByGame")
        .mockImplementationOnce(async (id) => (await list(id)).filter((x) => x.userId !== b.userId));
      try {
        const confirmed = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
        expect(confirmed.status).toBe(200);
        expect([...confirmed.body.game.drawOrder].sort()).toEqual([a.userId, b.userId].sort());
      } finally {
        spy.mockRestore();
      }
    });

    it("確定を待っている間に参加した人も抽選に入り、確定した後の参加人数は抽選に入った人だけを数える", async () => {
      const admin = await t.adminClient();
      const game = (await admin("POST", "/api/admin/games", { format: "lottery", name: "待つ間", ranks })).body.game;
      await admin("POST", `/api/admin/games/${game.gameId}/open`);
      const a = await participant("先に参加");
      const b = await participant("待つ間に参加");
      const c = await participant("会場を離れる");
      for (const p of [a, c]) await p.request("PUT", `/api/game/${game.gameId}/answer`, { entry: true });
      await admin("POST", `/api/admin/users/${c.userId}/unbind`);
      // 確定の 1 回目の読み取りの後、待っている間に参加する
      t.settle = async () => {
        expect((await b.request("PUT", `/api/game/${game.gameId}/answer`, { entry: true })).status).toBe(200);
      };
      const confirmed = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect([...confirmed.body.game.drawOrder].sort()).toEqual([a.userId, b.userId].sort());
      // 紐づけを解除した人は抽選に入らず、参加人数にも数えない（保存された答えは 3 件）
      expect(confirmed.body.game).toMatchObject({ answerCount: 2, storedAnswerCount: 3 });
    });

    it("入力の検証と、範囲が無いと確定できないこと", async () => {
      const admin = await t.adminClient();
      const game = (await admin("POST", "/api/admin/games", { format: "lottery", name: "抽選" })).body.game;
      const res = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("点数の範囲を追加してから確定してください");
      expect(
        await admin("POST", "/api/admin/games", { format: "lottery", name: "x", keyword: "a" }).then((r) => r.status),
      ).toBe(400);
      // 参加者がいなくても確定できる（誰にも入らない）
      await admin("PUT", `/api/admin/games/${game.gameId}`, { format: "lottery", name: "抽選", ranks });
      const empty = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(empty.status).toBe(200);
      expect(empty.body.game.drawOrder).toEqual([]);
    });
  });
});

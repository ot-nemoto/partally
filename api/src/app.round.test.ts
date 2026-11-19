import { describe, expect, it } from "vitest";
import { type Client, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("ラウンド", () => {
    let participantSeq = 0;
    const participant = (name: string) => t.register(name, [4, participantSeq++]);

    const quiz = async (admin: Client, name: string) =>
      (
        await admin("POST", "/api/admin/games", {
          format: "quiz",
          name,
          choices: [
            { text: "A", points: 10 },
            { text: "B", points: 0 },
          ],
        })
      ).body.game;
    const statuses = async (admin: Client) =>
      Object.fromEntries((await admin("GET", "/api/admin/games")).body.games.map((g: any) => [g.name, g.status]));

    it("作って、開始で全問を出し、参加者は全問に答えられ、終了でまとめて同じ時刻に終了する", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const [q1, q2, q3] = [await quiz(admin, "Q1"), await quiz(admin, "Q2"), await quiz(admin, "Q3")];

      const created = await admin("POST", "/api/admin/rounds", { name: " 第 1 部 ", gameIds: [q2.gameId, q1.gameId] });
      expect(created.status).toBe(201);
      const round = created.body.round;
      expect(round).toMatchObject({ name: "第 1 部", gameIds: [q2.gameId, q1.gameId], status: "draft" });
      // ゲームの一覧に、入っているラウンドが付く
      const games = (await admin("GET", "/api/admin/games")).body.games;
      expect(games.find((g: any) => g.name === "Q1").roundId).toBe(round.roundId);
      expect(games.find((g: any) => g.name === "Q3")).not.toHaveProperty("roundId");

      // ラウンドのゲームは 1 問だけでは開始できない
      expect((await admin("POST", `/api/admin/games/${q1.gameId}/open`)).status).toBe(409);

      // 開始すると、ラウンドの順に全問が出る
      expect((await admin("POST", `/api/admin/rounds/${round.roundId}/open`)).body.round.status).toBe("open");
      expect(await statuses(admin)).toEqual({ Q1: "open", Q2: "open", Q3: "draft" });
      const current = (await a.request("GET", "/api/game/current")).body;
      expect(current.round).toEqual({ roundId: round.roundId, name: "第 1 部" });
      expect(current.games.map((g: any) => g.name)).toEqual(["Q2", "Q1"]);
      expect(current.game.name).toBe("Q2");

      // 開催中は、ほかのゲームもラウンドも開始できない。開始中はゲームを出し入れできない（名前は直せる）
      expect((await admin("POST", `/api/admin/games/${q3.gameId}/open`)).status).toBe(409);
      const other = (await admin("POST", "/api/admin/rounds", { name: "第 2 部", gameIds: [q3.gameId] })).body.round;
      expect((await admin("POST", `/api/admin/rounds/${other.roundId}/open`)).status).toBe(409);
      expect(
        (await admin("PUT", `/api/admin/rounds/${round.roundId}`, { name: "第 1 部", gameIds: [q1.gameId] })).status,
      ).toBe(409);
      const renamed = await admin("PUT", `/api/admin/rounds/${round.roundId}`, {
        name: "前半",
        gameIds: [q2.gameId, q1.gameId],
      });
      expect(renamed.body.round.name).toBe("前半");

      // 参加者は全問に答えられる
      for (const g of current.games) {
        const res = await a.request("PUT", `/api/game/${g.gameId}/answer`, { choiceId: g.choices[0].choiceId });
        expect(res.status).toBe(200);
      }
      expect((await a.request("GET", "/api/game/current")).body.games.every((g: any) => g.myChoiceId)).toBe(true);

      // 終了でまとめて終了し、同じ時刻にポイントが入る
      const confirmed = await admin("POST", `/api/admin/rounds/${round.roundId}/confirm`);
      expect(confirmed.body.round.status).toBe("confirmed");
      expect(await statuses(admin)).toMatchObject({ Q1: "confirmed", Q2: "confirmed" });
      const times = (await admin("GET", "/api/admin/games")).body.games
        .filter((g: any) => g.status === "confirmed")
        .map((g: any) => g.confirmedAt);
      expect(new Set(times).size).toBe(1);
      expect((await a.request("GET", "/api/me")).body.user.gamePoints).toBe(20);
      expect((await a.request("GET", "/api/game/current")).body).toEqual({ game: null, games: [] });

      // 終了の取り消しもまとめて下書きに戻す（ポイントも消える）
      expect((await admin("POST", `/api/admin/rounds/${round.roundId}/unconfirm`)).body.round.status).toBe("draft");
      expect(await statuses(admin)).toMatchObject({ Q1: "draft", Q2: "draft" });
      expect((await a.request("GET", "/api/me")).body.user.gamePoints).toBe(0);

      // 開始してから中断すると、全問が下書きに戻り、ほかを開始できる
      await admin("POST", `/api/admin/rounds/${round.roundId}/open`);
      expect((await admin("POST", `/api/admin/rounds/${round.roundId}/stop`)).body.round.status).toBe("draft");
      expect(await statuses(admin)).toMatchObject({ Q1: "draft", Q2: "draft" });
      expect((await admin("POST", `/api/admin/rounds/${other.roundId}/open`)).status).toBe(200);
    });

    it("入れられるゲームの決まり: あるもの・下書き・ほかのラウンドに入っていない・重複なし。空では開始できない", async () => {
      const admin = await t.adminClient();
      const [q1, q2] = [await quiz(admin, "Q1"), await quiz(admin, "Q2")];
      const post = (body: object) => admin("POST", "/api/admin/rounds", body).then((r) => r.status);
      expect(await post({ name: "", gameIds: [] })).toBe(400);
      expect(await post({ name: "R", gameIds: [q1.gameId, q1.gameId] })).toBe(400);
      expect(await post({ name: "R", gameIds: ["NOPE"] })).toBe(400);
      const r1 = (await admin("POST", "/api/admin/rounds", { name: "R1", gameIds: [q1.gameId] })).body.round;
      expect(await post({ name: "R2", gameIds: [q1.gameId] })).toBe(409);
      // 開始中の 1 問は入れられない
      await admin("POST", `/api/admin/games/${q2.gameId}/open`);
      expect(await post({ name: "R2", gameIds: [q2.gameId] })).toBe(409);
      await admin("POST", `/api/admin/games/${q2.gameId}/stop`);

      const empty = (await admin("POST", "/api/admin/rounds", { name: "空", gameIds: [] })).body.round;
      expect((await admin("POST", `/api/admin/rounds/${empty.roundId}/open`)).status).toBe(409);

      // 終了できない問題があれば、理由を添えて 409（ゲームは開始中のまま）
      const number = (await admin("POST", "/api/admin/games", { format: "number", name: "数" })).body.game;
      await admin("PUT", `/api/admin/rounds/${r1.roundId}`, { name: "R1", gameIds: [q1.gameId, number.gameId] });
      await admin("POST", `/api/admin/rounds/${r1.roundId}/open`);
      const res = await admin("POST", `/api/admin/rounds/${r1.roundId}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain("「数」");
      expect(await statuses(admin)).toMatchObject({ Q1: "open", 数: "open" });
    });

    it("並べ替え・削除。ラウンドを消してもゲームは残り、ゲームを消すとラウンドから外れる", async () => {
      const admin = await t.adminClient();
      const [q1, q2] = [await quiz(admin, "Q1"), await quiz(admin, "Q2")];
      const r1 = (await admin("POST", "/api/admin/rounds", { name: "R1", gameIds: [q1.gameId, q2.gameId] })).body.round;
      const r2 = (await admin("POST", "/api/admin/rounds", { name: "R2", gameIds: [] })).body.round;
      const names = async () => (await admin("GET", "/api/admin/rounds")).body.rounds.map((r: any) => r.name);
      expect(await names()).toEqual(["R1", "R2"]);
      expect((await admin("PUT", "/api/admin/rounds/order", { roundIds: [r2.roundId] })).status).toBe(400);
      expect((await admin("PUT", "/api/admin/rounds/order", { roundIds: [r2.roundId, r1.roundId] })).status).toBe(200);
      expect(await names()).toEqual(["R2", "R1"]);

      await admin("DELETE", `/api/admin/games/${q1.gameId}`);
      expect((await admin("GET", "/api/admin/rounds")).body.rounds[1].gameIds).toEqual([q2.gameId]);

      // 開始中は消せない
      await admin("POST", `/api/admin/rounds/${r1.roundId}/open`);
      expect((await admin("DELETE", `/api/admin/rounds/${r1.roundId}`)).status).toBe(409);
      await admin("POST", `/api/admin/rounds/${r1.roundId}/stop`);
      expect((await admin("DELETE", `/api/admin/rounds/${r1.roundId}`)).status).toBe(200);
      expect(await names()).toEqual(["R2"]);
      // ラウンドから外れたゲームは 1 問で開始できる
      expect((await admin("POST", `/api/admin/games/${q2.gameId}/open`)).status).toBe(200);
    });
  });
});

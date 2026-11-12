import { describe, expect, it, vi } from "vitest";
import { type Client, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("ゲーム", () => {
    let participantSeq = 0;
    const participant = (name: string) => t.register(name, [2, participantSeq++]);

    const me = async (request: Client) => (await request("GET", "/api/me")).body.user;
    const pointsOf = async (admin: Client) =>
      Object.fromEntries(
        (await admin("GET", "/api/admin/users")).body.users.map((u: any) => [u.name, [u.points, u.gamePoints]]),
      );

    it("作った・直したゲームは下書きのままではポイントに入らず、確定すると入り、取り消すと消える", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");
      const c = await participant("佐藤");
      const created = await admin("POST", "/api/admin/games", {
        format: "result",
        name: " じゃんけん大会 ",
        slots: [
          { name: "優勝", points: 30, userIds: [a.userId] },
          { name: "ベスト 4", points: 10, userIds: [] },
        ],
      });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game).toMatchObject({ name: "じゃんけん大会", status: "draft" });
      expect(game.confirmedAt).toBeUndefined();
      expect(game.slots.map((s: any) => [s.name, s.points, s.userIds])).toEqual([
        ["優勝", 30, [a.userId]],
        ["ベスト 4", 10, []],
      ]);
      expect(await pointsOf(admin)).toMatchObject({ 田中: [0, 0] });

      // 人を選び直す（枠の ID は残し、新しい枠を足す）
      const [win, best] = game.slots;
      const edited = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "じゃんけん大会",
        slots: [
          { slotId: win.slotId, name: "優勝", points: 30, userIds: [a.userId] },
          { name: "準優勝", points: 20, userIds: [b.userId] },
          { slotId: best.slotId, name: "ベスト 4", points: 10, userIds: [c.userId] },
        ],
      });
      expect(edited.status).toBe(200);
      expect(edited.body.game.slots.map((s: any) => s.slotId)).toEqual([win.slotId, expect.any(String), best.slotId]);
      expect(await pointsOf(admin)).toMatchObject({ 田中: [0, 0], 鈴木: [0, 0], 佐藤: [0, 0] });

      const confirmed = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.game.status).toBe("confirmed");
      const confirmedAt = confirmed.body.game.confirmedAt;
      expect(confirmedAt).toEqual(expect.any(String));
      expect(await pointsOf(admin)).toMatchObject({ 田中: [30, 30], 鈴木: [20, 20], 佐藤: [10, 10] });
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(409);

      // 参加者のホーム: 点数と入った枠
      expect(await me(a.request)).toMatchObject({
        points: 30,
        gamePoints: 30,
        gameAwards: [{ gameName: "じゃんけん大会", slotName: "優勝", points: 30 }],
      });

      // ランキングと推移: 確定した時刻に入る
      const ranking = (await admin("GET", "/api/admin/ranking")).body.ranking;
      expect(ranking.map((e: any) => [e.name, e.points])).toEqual([
        ["田中", 30],
        ["鈴木", 20],
        ["佐藤", 10],
      ]);
      expect(ranking[0].history).toContainEqual({ at: confirmedAt, points: 30 });

      // 確定後に直すと数え直す（確定した時刻は変わらない）
      const fixed = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "じゃんけん大会",
        slots: [
          { slotId: win.slotId, name: "優勝", points: 50, userIds: [b.userId] },
          { slotId: best.slotId, name: "ベスト 4", points: 10, userIds: [a.userId, c.userId] },
        ],
      });
      expect(fixed.body.game).toMatchObject({ status: "confirmed", confirmedAt });
      expect(await pointsOf(admin)).toMatchObject({ 田中: [10, 10], 鈴木: [50, 50], 佐藤: [10, 10] });

      const draft = await admin("POST", `/api/admin/games/${game.gameId}/unconfirm`);
      expect(draft.body.game.status).toBe("draft");
      expect(draft.body.game.confirmedAt).toBeUndefined();
      expect(await pointsOf(admin)).toMatchObject({ 田中: [0, 0], 鈴木: [0, 0], 佐藤: [0, 0] });
      expect((await admin("POST", `/api/admin/games/${game.gameId}/unconfirm`)).status).toBe(409);

      await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect((await admin("DELETE", `/api/admin/games/${game.gameId}`)).status).toBe(200);
      expect((await admin("GET", "/api/admin/games")).body.games).toEqual([]);
      expect(await pointsOf(admin)).toMatchObject({ 鈴木: [0, 0] });
      expect((await admin("DELETE", `/api/admin/games/${game.gameId}`)).status).toBe(404);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(404);
    });

    it("入力を確かめる（点数の範囲・同じ人が 2 つの枠・知らない人や枠）", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const post = (slots: unknown[]) => admin("POST", "/api/admin/games", { format: "result", name: "大会", slots });
      expect((await post([{ name: "優勝", points: 101, userIds: [] }])).status).toBe(400);
      expect((await post([{ name: "優勝", points: -1, userIds: [] }])).status).toBe(400);
      expect(
        (
          await post([
            { name: "優勝", points: 30, userIds: [a.userId] },
            { name: "準優勝", points: 20, userIds: [a.userId] },
          ])
        ).status,
      ).toBe(400);
      expect((await post([{ name: "優勝", points: 30, userIds: ["UNKNOWN"] }])).status).toBe(400);
      expect((await post([{ slotId: "S1", name: "優勝", points: 30, userIds: [] }])).status).toBe(400);
      expect((await admin("GET", "/api/admin/games")).body.games).toEqual([]);
      expect(
        (
          await admin("PUT", "/api/admin/games/NONE", {
            format: "result",
            name: "大会",
            slots: [{ name: "優勝", points: 1, userIds: [] }],
          })
        ).status,
      ).toBe(404);
    });

    it("画面が持っている版（updatedAt）がほかで変わっていたら、上書きせず 409 にする", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
        const admin = await t.adminClient();
        const a = await participant("田中");
        const b = await participant("鈴木");
        const { game } = (
          await admin("POST", "/api/admin/games", {
            format: "result",
            name: "大会",
            slots: [
              { name: "優勝", points: 30, userIds: [] },
              { name: "準優勝", points: 20, userIds: [] },
            ],
          })
        ).body;
        expect(game.updatedAt).toBe("2026-01-01T01:00:00.000Z");
        const [win, second] = game.slots;
        const body = (winners: string[], seconds: string[], baseUpdatedAt?: string) => ({
          format: "result",
          name: "大会",
          slots: [
            { slotId: win.slotId, name: "優勝", points: 30, userIds: winners },
            { slotId: second.slotId, name: "準優勝", points: 20, userIds: seconds },
          ],
          baseUpdatedAt,
        });
        // 1 つ目の枠を保存（版が進む）
        vi.setSystemTime(new Date("2026-01-01T01:01:00.000Z"));
        const first = await admin("PUT", `/api/admin/games/${game.gameId}`, body([a.userId], [], game.updatedAt));
        expect(first.status).toBe(200);
        expect(first.body.game.updatedAt).toBe("2026-01-01T01:01:00.000Z");
        // 古い版のまま 2 つ目の枠を保存すると 409 で、1 つ目の枠は消えない
        vi.setSystemTime(new Date("2026-01-01T01:02:00.000Z"));
        const stale = await admin("PUT", `/api/admin/games/${game.gameId}`, body([], [b.userId], game.updatedAt));
        expect(stale.status).toBe(409);
        const list = (await admin("GET", "/api/admin/games")).body.games;
        expect(list[0].slots.map((s: any) => s.userIds)).toEqual([[a.userId], []]);
        // 今の版なら保存できる。確定・取り消しでも版は進む
        const ok = await admin(
          "PUT",
          `/api/admin/games/${game.gameId}`,
          body([a.userId], [b.userId], first.body.game.updatedAt),
        );
        expect(ok.status).toBe(200);
        vi.setSystemTime(new Date("2026-01-01T01:03:00.000Z"));
        const confirmed = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
        expect(confirmed.body.game.updatedAt).toBe("2026-01-01T01:03:00.000Z");
        expect(
          (await admin("PUT", `/api/admin/games/${game.gameId}`, body([a.userId], [], ok.body.game.updatedAt))).status,
        ).toBe(409);
      } finally {
        vi.useRealTimers();
      }
    });

    it("名前だけで作れ、枠は後から足せる。枠が無いゲームは確定できない", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const created = await admin("POST", "/api/admin/games", { format: "result", name: "ビンゴ", slots: [] });
      expect(created.status).toBe(201);
      const { game } = created.body;
      expect(game.slots).toEqual([]);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(409);
      expect((await admin("GET", "/api/admin/games")).body.games[0].status).toBe("draft");

      const added = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "ビンゴ",
        slots: [{ name: "1 番乗り", points: 10, userIds: [a.userId] }],
        baseUpdatedAt: game.updatedAt,
      });
      expect(added.status).toBe(200);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);
      expect(await pointsOf(admin)).toMatchObject({ 田中: [10, 10] });
      // 確定したまま枠を全部外すと、入ったポイントが黙って消えるので受け付けない
      const emptied = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "ビンゴ",
        slots: [],
      });
      expect(emptied.status).toBe(409);
      expect(emptied.body.message).toContain("先に確定を取り消してください");
      expect(await pointsOf(admin)).toMatchObject({ 田中: [10, 10] });
      // 確定を取り消せば、枠を全部外せる
      expect((await admin("POST", `/api/admin/games/${game.gameId}/unconfirm`)).status).toBe(200);
      const drafted = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "ビンゴ",
        slots: [],
      });
      expect(drafted.status).toBe(200);
      expect(await pointsOf(admin)).toMatchObject({ 田中: [0, 0] });
      expect((await admin("POST", "/api/admin/games/NONE/confirm")).status).toBe(404);
    });

    it("以前の版で枠を外してあった確定済みのゲームは、名前などを直せる", async () => {
      const admin = await t.adminClient();
      const game = (await admin("POST", "/api/admin/games", { format: "result", name: "むかしの大会" })).body.game;
      // 枠の無いまま確定になっている（以前は確定後に枠を全部外せた）
      await t.repo.changeGameStatus(game.gameId, "draft", "confirmed", "2026-01-01T00:00:00.000Z");
      const renamed = await admin("PUT", `/api/admin/games/${game.gameId}`, { format: "result", name: "昔の大会" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.game).toMatchObject({ name: "昔の大会", status: "confirmed", slots: [] });
    });

    it("紐づけを解除した人は新しく選べないが、選んだ後に解除された人はそのまま残せる", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");
      const { game } = (
        await admin("POST", "/api/admin/games", {
          format: "result",
          name: "大会",
          slots: [{ name: "優勝", points: 10, userIds: [a.userId] }],
        })
      ).body;
      await admin("POST", `/api/admin/users/${a.userId}/unbind`);
      await admin("POST", `/api/admin/users/${b.userId}/unbind`);
      const slotId = game.slots[0].slotId;
      const put = (userIds: string[]) =>
        admin("PUT", `/api/admin/games/${game.gameId}`, {
          format: "result",
          name: "大会",
          slots: [{ slotId, name: "優勝", points: 10, userIds }],
        });
      expect((await put([a.userId])).status).toBe(200);
      expect((await put([a.userId, b.userId])).status).toBe(400);
      expect(
        (
          await admin("POST", "/api/admin/games", {
            format: "result",
            name: "別",
            slots: [{ name: "優勝", points: 10, userIds: [a.userId] }],
          })
        ).status,
      ).toBe(400);
    });

    it("ゲームの点数を伏せると、参加者には点数と入った枠を返さない（合計には入る）", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const { game } = (
        await admin("POST", "/api/admin/games", {
          format: "result",
          name: "大会",
          slots: [{ name: "勝ち残り", points: 10, userIds: [a.userId] }],
        })
      ).body;
      await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      const settings = (await admin("GET", "/api/admin/settings")).body.settings;
      await admin("PUT", "/api/admin/settings", { ...settings, showGamePoints: false });
      const user = await me(a.request);
      expect(user.points).toBe(10);
      expect(user.gamePoints).toBeUndefined();
      expect(user.gameAwards).toBeUndefined();
      expect((await a.request("GET", "/api/me")).body.rules.showGamePoints).toBe(false);
    });

    it("管理画面以外からは操作できない", async () => {
      const a = await participant("田中");
      expect((await a.request("GET", "/api/admin/games")).status).toBe(401);
      expect((await a.request("POST", "/api/admin/games", { name: "x", slots: [] })).status).toBe(401);
    });
  });
});

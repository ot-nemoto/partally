import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestUpload } from "./ingest.js";
import { type Client, createClient, jpegBytes, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("イベントの終了", () => {
    let participantSeq = 0;
    const participant = (name: string) => t.register(name, [3, participantSeq++]);

    // 押した時刻の前後を分けるため、1 秒ずつ進める
    let now = Date.now();
    const tick = () => {
      now += 1000;
      vi.setSystemTime(now);
    };
    afterEach(() => vi.useRealTimers());

    /** 写真を上げて承認する（公開した時刻にポイントが入る） */
    async function publishPhoto(request: Client, admin: Client) {
      const res = await request("POST", "/api/photos/upload-url");
      for (const kind of ["thumb", "full"] as const) {
        const { fields } = res.body[kind];
        t.storage.put(fields.key, jpegBytes(), fields["x-amz-meta-uploader"]);
      }
      await ingestUpload(t, res.body.full.fields.key);
      expect((await admin("POST", `/api/admin/photos/${res.body.photoId}/approve`)).status).toBe(200);
      return res.body.photoId as string;
    }

    /** 結果入力のゲームを作って開始し、終了する（枠の人に points が入る） */
    async function finishGame(admin: Client, userId: string, points: number) {
      const game = (
        await admin("POST", "/api/admin/games", {
          format: "result",
          name: `大会${points}`,
          slots: [{ name: "優勝", points, userIds: [userId] }],
        })
      ).body.game;
      await admin("POST", `/api/admin/games/${game.gameId}/open`);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);
    }

    const pointsOf = async (admin: Client) =>
      Object.fromEntries(
        (await admin("GET", "/api/admin/users")).body.users.map((u: any) => [
          u.name,
          [u.points, u.approvedCount, u.favoritesReceived, u.favoritesGiven, u.gamePoints],
        ]),
      );

    it("押した後の写真・お気に入り・ゲームは数えず、受付は続く。取り消すと戻る", async () => {
      now = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      const admin = await t.adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");

      // 終了の前（既定の点数）: A が写真 1 枚（1 点）、B がそれを選ぶ（A に 1 点、B に 10 点）、A がゲームで 30 点
      tick();
      const photo1 = await publishPhoto(a.request, admin);
      tick();
      expect((await b.request("PUT", `/api/photos/${photo1}/favorite`)).status).toBe(200);
      tick();
      await finishGame(admin, a.userId, 30);
      const before = await pointsOf(admin);
      expect(before.田中).toEqual([32, 1, 1, 0, 30]);
      expect(before.鈴木).toEqual([10, 0, 0, 1, 0]);

      tick();
      expect((await admin("GET", "/api/admin/event")).body.endedAt).toBeUndefined();
      const ended = await admin("POST", "/api/admin/event/end");
      expect(ended.status).toBe(200);
      expect((await admin("GET", "/api/admin/event")).body.endedAt).toBe(ended.body.endedAt);
      expect((await admin("POST", "/api/admin/event/end")).status).toBe(409);
      // 参加者には終了した時刻を知らせる
      expect((await a.request("GET", "/api/me")).body.rules.eventEndedAt).toBe(ended.body.endedAt);

      // 終了の後: 受付は続くが、ポイントは増えない（写真・お気に入り・ゲーム・後から登録した人）
      tick();
      const photo2 = await publishPhoto(b.request, admin);
      tick();
      expect((await a.request("PUT", `/api/photos/${photo2}/favorite`)).status).toBe(200);
      tick();
      await finishGame(admin, b.userId, 50);
      const c = await participant("佐藤");
      tick();
      await publishPhoto(c.request, admin);
      expect(await pointsOf(admin)).toEqual({ ...before, 佐藤: [0, 0, 0, 0, 0] });
      expect((await b.request("GET", "/api/me")).body.user.points).toBe(10);

      // ランキング・推移も終了した時点で止まる
      const ranking = (await admin("GET", "/api/admin/ranking")).body.ranking;
      expect(ranking.map((r: any) => [r.name, r.points])).toEqual([
        ["田中", 32],
        ["鈴木", 10],
        ["佐藤", 0],
      ]);
      const bHistory = ranking.find((r: any) => r.name === "鈴木").history;
      expect(Math.max(...bHistory.map((p: any) => p.points))).toBe(10);

      // ゲームの結果では、終了の後に終了したゲームに印を付ける
      const { settings } = (await admin("GET", "/api/admin/settings")).body;
      await admin("PUT", "/api/admin/settings", { ...settings, gameResultsVisible: true });
      const results = (await a.request("GET", "/api/game-results")).body.games;
      expect(results.map((g: any) => [g.name, g.uncounted ?? false])).toEqual([
        ["大会30", false],
        ["大会50", true],
      ]);

      // 取り消すと、終了の後の分も数える
      expect((await admin("POST", "/api/admin/event/reopen")).status).toBe(200);
      expect((await a.request("GET", "/api/me")).body.rules).not.toHaveProperty("eventEndedAt");
      const after = await pointsOf(admin);
      expect(after.田中).toEqual([42, 1, 1, 1, 30]);
      expect(after.鈴木).toEqual([62, 1, 1, 1, 50]);
      expect(after.佐藤).toEqual([1, 1, 0, 0, 0]);
    });

    it("開催中のゲームやラウンドがあると終了できない（終了するか中断すれば終了できる）", async () => {
      const admin = await t.adminClient();
      const game = (
        await admin("POST", "/api/admin/games", {
          format: "quiz",
          name: "Q",
          choices: [
            { text: "A", points: 10 },
            { text: "B", points: 0 },
          ],
        })
      ).body.game;
      await admin("POST", `/api/admin/games/${game.gameId}/open`);
      const blocked = await admin("POST", "/api/admin/event/end");
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("invalid_state");
      expect((await admin("GET", "/api/admin/event")).body.endedAt).toBeUndefined();

      // 中断して、ラウンドで開始しても終了できない
      await admin("POST", `/api/admin/games/${game.gameId}/stop`);
      const round = (await admin("POST", "/api/admin/rounds", { name: "第 1 部", gameIds: [game.gameId] })).body.round;
      expect((await admin("POST", `/api/admin/rounds/${round.roundId}/open`)).status).toBe(200);
      expect((await admin("POST", "/api/admin/event/end")).status).toBe(409);

      // ラウンドを終了すれば終了できる
      expect((await admin("POST", `/api/admin/rounds/${round.roundId}/confirm`)).status).toBe(200);
      expect((await admin("POST", "/api/admin/event/end")).status).toBe(200);
    });

    it("終了した後、設定でオンにした項目だけ、ホーム画面に自分の順位と景品を返す", async () => {
      const admin = await t.adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");
      await finishGame(admin, a.userId, 30);
      await finishGame(admin, b.userId, 10);
      const first = (await admin("POST", "/api/admin/prizes", { name: "TV", quantity: 1, positions: [1] })).body.prize;
      const second = (await admin("POST", "/api/admin/prizes", { name: "お菓子", quantity: 2, positions: [1, 2] })).body
        .prize;
      const settings = (await admin("GET", "/api/admin/settings")).body.settings;
      expect(settings).toMatchObject({ homeRankVisible: false, homePrizeVisible: false });
      const set = (changes: object) => admin("PUT", "/api/admin/settings", { ...settings, ...changes });
      const standing = async (request: Client) => {
        const res = await request("GET", "/api/me/standing");
        return res.status === 200 ? res.body : res.status;
      };

      // 終了する前は、オンにしていても返さない
      await set({ homeRankVisible: true, homePrizeVisible: true });
      expect((await a.request("GET", "/api/me")).body.rules).toMatchObject({
        homeRankVisible: true,
        homePrizeVisible: true,
      });
      expect(await standing(a.request)).toBe(404);

      expect((await admin("POST", "/api/admin/event/end")).status).toBe(200);
      const mine = await standing(a.request);
      expect(mine.rank).toBe(1);
      expect(mine.prizes.map((p: any) => p.prizeId)).toEqual([first.prizeId, second.prizeId]);
      const theirs = await standing(b.request);
      expect(theirs.rank).toBe(2);
      expect(theirs.prizes.map((p: any) => p.name)).toEqual(["お菓子"]);

      // 景品の無い順位は、空の一覧
      const c = await participant("佐藤");
      expect(await standing(c.request)).toEqual({ rank: 3, prizes: [] });

      // オンにした項目だけを返し、両方オフなら無いものとして扱う
      await set({ homeRankVisible: true, homePrizeVisible: false });
      expect(await standing(a.request)).toEqual({ rank: 1 });
      await set({ homeRankVisible: false, homePrizeVisible: true });
      expect(await standing(a.request)).not.toHaveProperty("rank");
      await set({ homeRankVisible: false, homePrizeVisible: false });
      expect(await standing(a.request)).toBe(404);

      // 終了を取り消すと、どちらもオフに戻り、返さない（もう一度終了しても、オンにするまで出ない）
      await set({ homeRankVisible: true, homePrizeVisible: true });
      await admin("POST", "/api/admin/event/reopen");
      expect((await admin("GET", "/api/admin/settings")).body.settings).toMatchObject({
        homeRankVisible: false,
        homePrizeVisible: false,
      });
      expect(await standing(a.request)).toBe(404);
      await admin("POST", "/api/admin/event/end");
      expect(await standing(a.request)).toBe(404);
      // ログインしていなければ 401
      expect((await createClient(t.app)("GET", "/api/me/standing")).status).toBe(401);
    });
  });
});

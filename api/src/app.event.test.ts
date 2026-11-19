import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestUpload } from "./ingest.js";
import { type Client, useApiTest } from "./test-support.js";

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
        t.storage.put(fields.key, new Uint8Array([1, 2, 3]), fields["x-amz-meta-uploader"]);
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

      // 取り消すと、終了の後の分も数える
      expect((await admin("POST", "/api/admin/event/reopen")).status).toBe(200);
      expect((await a.request("GET", "/api/me")).body.rules).not.toHaveProperty("eventEndedAt");
      const after = await pointsOf(admin);
      expect(after.田中).toEqual([42, 1, 1, 1, 30]);
      expect(after.鈴木).toEqual([62, 1, 1, 1, 50]);
      expect(after.佐藤).toEqual([1, 1, 0, 0, 0]);
    });
  });
});

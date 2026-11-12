import { describe, expect, it } from "vitest";
import { ingestUpload } from "./ingest.js";
import { DEFAULT_SETTINGS } from "./repository.js";
import { type Client, createClient, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("ポイントとお気に入り", () => {
    let participantSeq = 0;
    // 二つ名が重ならないよう、参加者ごとに称号を変える
    const participant = (name: string) => t.register(name, [0, participantSeq++]);

    const adminClient = () => t.adminClient();

    async function uploadAs(request: Client) {
      const res = await request("POST", "/api/photos/upload-url");
      for (const kind of ["thumb", "full"] as const) {
        const { fields } = res.body[kind];
        t.storage.put(fields.key, new Uint8Array([1]), fields["x-amz-meta-uploader"]);
      }
      await ingestUpload({ repo: t.repo, storage: t.storage }, res.body.full.fields.key);
      return res.body.photoId as string;
    }

    async function setup() {
      await t.repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "post" });
      const a = await participant("田中");
      const b = await participant("鈴木");
      const photoA1 = await uploadAs(a.request);
      const photoA2 = await uploadAs(a.request);
      const photoB = await uploadAs(b.request);
      return { a, b, photoA1, photoA2, photoB, admin: await adminClient() };
    }

    const me = async (request: Client) => (await request("GET", "/api/me")).body;

    it("公開された写真 1 枚ごとにポイントが付き、設定を変えると現在の設定で数え直す", async () => {
      const { a, admin } = await setup();
      const before = await me(a.request);
      expect(before.user).toMatchObject({ approvedCount: 2, points: 2 });
      expect(before.rules).toEqual({
        uploadPoints: 1,
        favoritesEnabled: true,
        favoriteLimit: 10,
        favoritePoints: 1,
        favoriteGivenPoints: 10,
        showPoints: true,
        showGamePoints: true,
        rankingVisible: false,
        rankingHideNames: false,
        rankingHidePoints: false,
        trendVisible: false,
        trendHideNames: false,
        trendHidePoints: false,
        prizesVisible: false,
        tieBreakOrder: ["upload", "favoriteGiven", "favoriteReceived", "game", "registered"],
        scheduleVisible: false,
        scheduleDate: "",
      });

      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", uploadPoints: 3 });
      expect((await me(a.request)).user.points).toBe(6);
      const users = (await admin("GET", "/api/admin/users")).body.users;
      expect(users.map((u: any) => [u.name, u.points])).toEqual([
        ["田中", 6],
        ["鈴木", 3],
      ]);
    });

    it("ポイントを伏せると、参加者向けの応答からポイント・選ばれた数・♥ の数を除く（管理画面では見える）", async () => {
      const { a, b, photoA1, admin } = await setup();
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect((await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showPoints: false })).status).toBe(200);

      const mine = await me(a.request);
      expect(mine.rules.showPoints).toBe(false);
      expect(mine.user).toMatchObject({ approvedCount: 2, favoritesGiven: 0 });
      expect(mine.user).not.toHaveProperty("points");
      expect(mine.user).not.toHaveProperty("favoritesReceived");
      for (const p of (await b.request("GET", "/api/photos")).body.photos)
        expect(p).not.toHaveProperty("favoriteCount");
      for (const p of (await a.request("GET", "/api/photos/mine")).body.photos)
        expect(p).not.toHaveProperty("favoriteCount");
      const res = await b.request("DELETE", `/api/photos/${photoA1}/favorite`);
      expect(res.body.photo).not.toHaveProperty("favoriteCount");
      expect(res.body.user).not.toHaveProperty("points");

      const users = (await admin("GET", "/api/admin/users")).body.users;
      expect(users.find((u: any) => u.name === "田中")).toMatchObject({ points: 2, favoritesReceived: 0 });
    });

    it("showPoints を送らない（古い画面からの）保存では、今の値を残す", async () => {
      const { admin } = await setup();
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showPoints: false });
      const { showPoints: _showPoints, ...withoutShowPoints } = DEFAULT_SETTINGS;
      const res = await admin("PUT", "/api/admin/settings", { ...withoutShowPoints, favoriteLimit: 5 });
      expect(res.status).toBe(200);
      expect(res.body.settings).toMatchObject({ showPoints: false, favoriteLimit: 5 });
      expect((await admin("GET", "/api/admin/settings")).body.settings.showPoints).toBe(false);
    });

    it("検閲待ちの写真はポイントにならない", async () => {
      await t.repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "pre" });
      const a = await participant("田中");
      await uploadAs(a.request);
      expect((await me(a.request)).user).toMatchObject({ uploadCount: 1, approvedCount: 0, points: 0 });
    });

    it("他人の写真をお気に入りにすると、選ばれた人と選んだ人にポイントが付く。二重には数えない", async () => {
      const { a, b, photoA1 } = await setup();
      const res = await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect(res.status).toBe(200);
      expect(res.body.photo).toMatchObject({ photoId: photoA1, favorited: true, favoriteCount: 1 });
      expect(res.body.user).toMatchObject({ favoritesGiven: 1 });
      expect((await b.request("PUT", `/api/photos/${photoA1}/favorite`)).status).toBe(200);

      expect((await me(a.request)).user).toMatchObject({ favoritesReceived: 1, points: 3 });
      // 鈴木: 写真 1 枚（1）と、お気に入りを 1 枚選んだ分（既定 10）
      expect((await me(b.request)).user).toMatchObject({ favoritesGiven: 1, points: 11 });

      const gallery = (await b.request("GET", "/api/photos")).body.photos;
      expect(gallery.find((p: any) => p.photoId === photoA1)).toMatchObject({ favorited: true, favoriteCount: 1 });
      expect(gallery.filter((p: any) => p.favorited)).toHaveLength(1);
    });

    it("自分の写真・検閲待ちの写真・存在しない写真は選べない", async () => {
      const { b, photoB, admin } = await setup();
      const self = await b.request("PUT", `/api/photos/${photoB}/favorite`);
      expect(self.status).toBe(409);
      expect(self.body.error).toBe("invalid_state");

      await admin("PUT", "/api/admin/settings", DEFAULT_SETTINGS);
      const c = await participant("佐藤");
      const pending = await uploadAs(c.request);
      expect((await b.request("PUT", `/api/photos/${pending}/favorite`)).body.error).toBe("invalid_state");
      expect((await b.request("PUT", "/api/photos/NOPE/favorite")).status).toBe(404);
    });

    it("選べる数には上限があり、外せば別の写真を選べる。外すと相手のポイントも減る", async () => {
      const { a, b, photoA1, photoA2, admin } = await setup();
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoriteLimit: 1 });

      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      const over = await b.request("PUT", `/api/photos/${photoA2}/favorite`);
      expect(over.status).toBe(409);
      expect(over.body.error).toBe("favorite_limit");

      const removed = await b.request("DELETE", `/api/photos/${photoA1}/favorite`);
      expect(removed.body.photo).toMatchObject({ favorited: false, favoriteCount: 0 });
      expect((await b.request("PUT", `/api/photos/${photoA2}/favorite`)).status).toBe(200);
      expect((await me(a.request)).user.favoritesReceived).toBe(1);
      // 選んでいない写真を外しても何も起きない
      expect((await b.request("DELETE", `/api/photos/${photoA1}/favorite`)).status).toBe(200);
      expect((await me(b.request)).user.favoritesGiven).toBe(1);
    });

    it("お気に入りを無効にすると追加も解除もできなくなるが、付いたポイントは残る", async () => {
      const { a, b, photoA1, photoA2, admin } = await setup();
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoritesEnabled: false });

      expect((await b.request("PUT", `/api/photos/${photoA2}/favorite`)).body.error).toBe("favorites_disabled");
      expect((await b.request("DELETE", `/api/photos/${photoA1}/favorite`)).body.error).toBe("favorites_disabled");
      expect((await me(a.request)).user).toMatchObject({ favoritesReceived: 1, points: 3 });
      expect((await me(b.request)).rules.favoritesEnabled).toBe(false);
    });

    it("お気に入りに選ばれた写真を削除すると、お気に入りが外れてポイントと選んだ人の枠が戻る", async () => {
      const { a, b, photoA1, admin } = await setup();
      const c = await participant("佐藤");
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      await c.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect((await me(a.request)).user).toMatchObject({ favoritesReceived: 2, points: 4 });

      expect((await admin("DELETE", `/api/admin/photos/${photoA1}`)).status).toBe(200);
      expect((await me(a.request)).user).toMatchObject({ approvedCount: 1, favoritesReceived: 0, points: 1 });
      expect((await me(b.request)).user.favoritesGiven).toBe(0);
      expect((await me(c.request)).user.favoritesGiven).toBe(0);
    });

    it("お気に入りを選んだ人のポイントは設定で変えられ、外すと戻る", async () => {
      const { a, b, photoA1, admin } = await setup();
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoriteGivenPoints: 4 });
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect((await me(b.request)).user.points).toBe(1 + 4);
      expect((await me(a.request)).user.points).toBe(2 + 1);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoriteGivenPoints: 0 });
      expect((await me(b.request)).user.points).toBe(1);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoriteGivenPoints: 4 });
      await b.request("DELETE", `/api/photos/${photoA1}/favorite`);
      expect((await me(b.request)).user.points).toBe(1);
      // 古い画面から favoriteGivenPoints を送らずに保存しても、今の値が残る
      const { favoriteGivenPoints: _omit, ...old } = { ...DEFAULT_SETTINGS, moderation: "post" as const };
      expect((await admin("PUT", "/api/admin/settings", old)).body.settings.favoriteGivenPoints).toBe(4);
    });

    it("ランキングは高い順に並び、累計の推移の最後がユーザ管理のポイントと一致する", async () => {
      const { a, b, photoA1, photoA2, admin } = await setup();
      const c = await participant("佐藤");
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      await c.request("PUT", `/api/photos/${photoA1}/favorite`);
      await c.request("PUT", `/api/photos/${photoA2}/favorite`);
      // 外したお気に入りは推移にも入らない
      await c.request("DELETE", `/api/photos/${photoA2}/favorite`);

      const res = await admin("GET", "/api/admin/ranking");
      expect(res.status).toBe(200);
      expect(
        res.body.ranking.map((r: any) => [r.rank, r.name, r.displayName === `〈${r.epithet}〉${r.name}`, r.points]),
      ).toEqual([
        // 鈴木: 写真 1 枚と選んだ 1 枚（10）、佐藤: 選んだ 1 枚（外した分は入らない）、田中: 写真 2 枚と選ばれた 2 件
        [1, "鈴木", true, 11],
        [2, "佐藤", true, 10],
        [3, "田中", true, 4],
      ]);
      const users = (await admin("GET", "/api/admin/users")).body.users;
      for (const entry of res.body.ranking) {
        const history = entry.history as { at: string; points: number }[];
        expect(history[0]!.points).toBe(0);
        expect(history.at(-1)).toEqual({ at: res.body.generatedAt, points: entry.points });
        expect(entry.points).toBe(users.find((u: any) => u.userId === entry.userId).points);
        // 時刻は古い順
        expect(history.map((h) => h.at)).toEqual(history.map((h) => h.at).toSorted());
      }
      // 田中: 写真 2 枚と選ばれた 2 件で、最後の点の前に 4 に達している
      expect(res.body.ranking[2].history.at(-2).points).toBe(4);
      expect(res.body.ranking[2].userId).toBe(a.userId);
      expect(res.body.ranking[0].userId).toBe(b.userId);
      // 佐藤: 選んだ時刻に 10 に上がる
      expect(res.body.ranking[1].history.map((h: any) => h.points)).toEqual([0, 10, 10]);
    });

    it("参加者のランキング・トレンドは、見せる設定のときだけ返す（既定は見せない）", async () => {
      const { a, admin } = await setup();
      expect((await a.request("GET", "/api/ranking")).status).toBe(404);
      expect((await a.request("GET", "/api/trend")).status).toBe(404);

      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, rankingVisible: true, trendVisible: true });
      const ranking = await a.request("GET", "/api/ranking");
      expect(ranking.status).toBe(200);
      expect(ranking.body).toMatchObject({ hideNames: false, hidePoints: false });
      expect(ranking.body.ranking.map((r: any) => [r.rank, r.name, r.points, r.history])).toEqual([
        [1, "田中", 2, []],
        [2, "鈴木", 1, []],
      ]);
      const trend = await a.request("GET", "/api/trend");
      expect(trend.body.ranking[0].history.at(-1).points).toBe(2);
      // ログインしていなければ見られない
      expect((await createClient(t.app)("GET", "/api/ranking")).status).toBe(401);
    });

    it("参加者のランキングで名前・ポイントを伏せると、名前・ID・実際の値を返さない", async () => {
      const { a, admin } = await setup();
      await admin("PUT", "/api/admin/settings", {
        ...DEFAULT_SETTINGS,
        uploadPoints: 3,
        rankingVisible: true,
        rankingHideNames: true,
        rankingHidePoints: true,
        trendVisible: true,
        trendHidePoints: true,
      });
      const ranking = (await a.request("GET", "/api/ranking")).body;
      expect(ranking).toMatchObject({ hideNames: true, hidePoints: true });
      // 田中 6 点・鈴木 3 点 → 1 位を 100 とした割合
      expect(ranking.ranking.map((r: any) => [r.rank, r.userId, r.name, r.epithet, r.displayName, r.points])).toEqual([
        [1, "r1", "???", "???", "???", 100],
        [2, "r2", "???", "???", "???", 50],
      ]);
      const text = JSON.stringify(ranking);
      expect(text).not.toContain("田中");
      expect(text).not.toContain(a.userId);

      // 名前を伏せると、登録した時刻（推移の始まり）も全員そろえる
      const hiddenTrend = await admin("PUT", "/api/admin/settings", {
        ...DEFAULT_SETTINGS,
        uploadPoints: 3,
        rankingVisible: true,
        rankingHideNames: true,
        rankingHidePoints: true,
        trendVisible: true,
        trendHideNames: true,
      });
      expect(hiddenTrend.status).toBe(200);
      const starts = (await a.request("GET", "/api/trend")).body.ranking.map((r: any) => r.history[0].at);
      expect(new Set(starts).size).toBe(1);
      await admin("PUT", "/api/admin/settings", {
        ...DEFAULT_SETTINGS,
        uploadPoints: 3,
        rankingVisible: true,
        rankingHideNames: true,
        rankingHidePoints: true,
        trendVisible: true,
        trendHidePoints: true,
      });

      // トレンドはポイントだけを伏せる（名前は見える）。推移も割合にする
      const trend = (await a.request("GET", "/api/trend")).body;
      expect(trend).toMatchObject({ hideNames: false, hidePoints: true });
      expect(trend.ranking.map((r: any) => [r.name, r.history.at(-1).points])).toEqual([
        ["田中", 100],
        ["鈴木", 50],
      ]);
    });

    it("参加者のランキングには、紐づけを解除した人を出さず、順位を付け直す", async () => {
      const { a, b, admin } = await setup();
      const c = await participant("佐藤");
      await uploadAs(c.request);
      await uploadAs(c.request);
      await uploadAs(c.request);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, rankingVisible: true });
      expect((await admin("POST", `/api/admin/users/${c.userId}/unbind`)).status).toBe(200);

      // 管理画面には解除した人も残る
      const all = (await admin("GET", "/api/admin/ranking")).body.ranking;
      expect(all.map((r: any) => [r.rank, r.name])).toEqual([
        [1, "佐藤"],
        [2, "田中"],
        [3, "鈴木"],
      ]);
      const ranking = (await a.request("GET", "/api/ranking")).body.ranking;
      expect(ranking.map((r: any) => [r.rank, r.name, r.points])).toEqual([
        [1, "田中", 2],
        [2, "鈴木", 1],
      ]);
      expect(b.userId).toBe(ranking[1].userId);
    });

    it("ランキングは管理者のログインが必要", async () => {
      const { a } = await setup();
      expect((await a.request("GET", "/api/admin/ranking")).status).toBe(401);
    });

    it("お気に入りの操作は参加者のログインが必要", async () => {
      const { photoA1 } = await setup();
      expect((await createClient(t.app)("PUT", `/api/photos/${photoA1}/favorite`)).status).toBe(401);
    });
  });
});

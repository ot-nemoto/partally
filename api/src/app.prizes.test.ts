import { describe, expect, it } from "vitest";
import { prizeImageKey } from "./photo-storage.js";
import { DEFAULT_SETTINGS } from "./repository.js";
import { type Client, createClient, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("景品", () => {
    async function participant() {
      const token = await t.issueToken();
      const request = createClient(t.app);
      await request("POST", "/api/auth/register", { token, name: "参加者" });
      return request;
    }

    /** 管理画面と同じく、アップロード URL をもらって画像を置く */
    async function uploadImage(admin: Client) {
      const res = await admin("POST", "/api/admin/prizes/image-upload", {});
      expect(res.status).toBe(200);
      t.storage.put(res.body.upload.fields.key, new Uint8Array([1, 2, 3]), "");
      return res.body.imageId as string;
    }

    /** 配信する領域に画像があるか */
    const served = (imageId: string) => t.storage.get(prizeImageKey(imageId)) !== undefined;

    it("登録・更新・削除ができ、順位は小さい順に並べ、画像は署名付き URL で返す", async () => {
      const admin = await t.adminClient();
      const imageId = await uploadImage(admin);
      const created = await admin("POST", "/api/admin/prizes", {
        name: "  ＴＶ  ",
        quantity: 3,
        positions: [3, 1],
        imageId,
      });
      expect(created.status).toBe(201);
      expect(created.body.prize).toMatchObject({
        name: "TV",
        quantity: 3,
        positions: [1, 3],
        imageUrl: `/prizes/${imageId}.jpg?signed`,
      });
      const prizeId = created.body.prize.prizeId;
      // 受け口から配信する領域へ移している
      expect(served(imageId)).toBe(true);
      expect(t.storage.get(prizeImageKey(imageId, "uploads"))).toBeUndefined();

      // 別の景品は同じ順位にも割り当てられ、画像なしでもよい
      const other = await admin("POST", "/api/admin/prizes", { name: "お菓子", quantity: 10, positions: [1, 2] });
      expect(other.status).toBe(201);
      expect(other.body.prize.imageUrl).toBeUndefined();

      const list = await admin("GET", "/api/admin/prizes");
      expect(list.body.prizes.map((p: any) => [p.name, p.positions])).toEqual([
        ["TV", [1, 3]],
        ["お菓子", [1, 2]],
      ]);

      // 画像を差し替えると古い画像を消す
      const newImageId = await uploadImage(admin);
      const updated = await admin("PUT", `/api/admin/prizes/${prizeId}`, {
        name: "テレビ",
        quantity: 2,
        positions: [2],
        imageId: newImageId,
      });
      expect(updated.status).toBe(200);
      expect(updated.body.prize).toMatchObject({ name: "テレビ", quantity: 2, positions: [2] });
      expect(served(imageId)).toBe(false);
      expect(served(newImageId)).toBe(true);

      // 画像を外しても消す
      const removed = await admin("PUT", `/api/admin/prizes/${prizeId}`, {
        name: "テレビ",
        quantity: 2,
        positions: [],
      });
      expect(removed.body.prize.imageUrl).toBeUndefined();
      expect(served(newImageId)).toBe(false);

      // 削除すると画像も消す
      const thirdImage = await uploadImage(admin);
      await admin("PUT", `/api/admin/prizes/${prizeId}`, {
        name: "テレビ",
        quantity: 2,
        positions: [],
        imageId: thirdImage,
      });
      expect((await admin("DELETE", `/api/admin/prizes/${prizeId}`)).status).toBe(200);
      expect(served(thirdImage)).toBe(false);
      expect((await admin("GET", "/api/admin/prizes")).body.prizes.map((p: any) => p.name)).toEqual(["お菓子"]);
      // 差し替え・外す・削除のたびに、CloudFront のキャッシュも消している
      expect(t.storage.removedPrizeImages).toEqual([imageId, newImageId, thirdImage]);
      expect((await admin("DELETE", `/api/admin/prizes/${prizeId}`)).status).toBe(404);
      expect(
        (await admin("PUT", `/api/admin/prizes/${prizeId}`, { name: "x", quantity: 1, positions: [] })).status,
      ).toBe(404);
    });

    it("数量を超える割り当て・重複した順位・アップロードしていない画像・他の景品の画像は 400", async () => {
      const admin = await t.adminClient();
      const post = (body: unknown) => admin("POST", "/api/admin/prizes", body);
      expect((await post({ name: "A", quantity: 2, positions: [1, 2, 3] })).status).toBe(400);
      expect((await post({ name: "A", quantity: 3, positions: [1, 1] })).status).toBe(400);
      expect((await post({ name: "A", quantity: 0, positions: [] })).status).toBe(400);
      expect((await post({ name: "A", quantity: 1, positions: [0] })).status).toBe(400);
      expect((await post({ name: "", quantity: 1, positions: [] })).status).toBe(400);
      // 画像が受け口に無いときは、ほかの入力の誤りと分けて image_not_uploaded を返す（画面がアップロードし直すため）
      expect(await post({ name: "A", quantity: 1, positions: [], imageId: "NOTUPLOADED" })).toMatchObject({
        status: 400,
        body: { error: "image_not_uploaded" },
      });

      const imageId = await uploadImage(admin);
      expect((await post({ name: "A", quantity: 1, positions: [1], imageId })).status).toBe(201);
      expect(await post({ name: "B", quantity: 1, positions: [1], imageId })).toMatchObject({
        status: 400,
        body: { error: "image_not_uploaded" },
      });
    });

    it("参加者には見せる設定のときだけ返し、管理者用の API は使えない", async () => {
      const admin = await t.adminClient();
      await admin("POST", "/api/admin/prizes", { name: "TV", quantity: 1, positions: [1] });
      const user = await participant();

      expect((await user("GET", "/api/prizes")).status).toBe(404);
      expect((await user("GET", "/api/admin/prizes")).status).toBe(401);
      expect((await createClient(t.app)("GET", "/api/prizes")).status).toBe(401);

      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, prizesVisible: true });
      expect((await user("GET", "/api/me")).body.rules.prizesVisible).toBe(true);
      const res = await user("GET", "/api/prizes");
      expect(res.status).toBe(200);
      expect(res.body.prizes.map((p: any) => [p.name, p.positions])).toEqual([["TV", [1]]]);
    });
  });
});

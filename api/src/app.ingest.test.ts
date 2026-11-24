import { describe, expect, it } from "vitest";
import { ingestUpload } from "./ingest.js";
import { photoKey } from "./photo-storage.js";
import { createClient, jpegBytes, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("取り込み（ingestUpload）", () => {
    async function activeUser() {
      const token = await t.issueToken();
      const reg = await createClient(t.app)("POST", "/api/auth/register", { token, name: "田中", pin: "1234" });
      return reg.body.user.userId as string;
    }

    it("対象外のキーは無視する", async () => {
      expect(await ingestUpload(t, "uploads/ID1/thumb.jpg")).toBe("ignored");
      expect(await ingestUpload(t, "photos/pending/ID1/full.jpg")).toBe("ignored");
      expect(await ingestUpload(t, "photos/approved/ID1/full.jpg")).toBe("ignored");
      expect(await ingestUpload(t, "other/file.jpg")).toBe("ignored");
    });

    it("サムネイルが無い・アップロード者が一致しない・ユーザが無効なら無視する", async () => {
      const userId = await activeUser();
      t.storage.put(photoKey("uploads", "P1", "full"), jpegBytes(), userId);
      expect(await ingestUpload(t, photoKey("uploads", "P1", "full"))).toBe("ignored");

      t.storage.put(photoKey("uploads", "P1", "thumb"), jpegBytes(), "someone-else");
      expect(await ingestUpload(t, photoKey("uploads", "P1", "full"))).toBe("ignored");

      t.storage.put(photoKey("uploads", "P2", "full"), jpegBytes(), "ghost");
      t.storage.put(photoKey("uploads", "P2", "thumb"), jpegBytes(), "ghost");
      expect(await ingestUpload(t, photoKey("uploads", "P2", "full"))).toBe("ignored");
    });

    it("同じイベントが重複して届いてもカウンタは 1 回だけ増える", async () => {
      const userId = await activeUser();
      t.storage.put(photoKey("uploads", "P1", "full"), jpegBytes(), userId);
      t.storage.put(photoKey("uploads", "P1", "thumb"), jpegBytes(), userId);
      expect(await ingestUpload(t, photoKey("uploads", "P1", "full"))).toBe("created");
      expect(await ingestUpload(t, photoKey("uploads", "P1", "full"))).toBe("duplicate");
      expect((await t.repo.getUser(userId))!.uploadCount).toBe(1);
    });

    it("本体かサムネイルが JPEG でなければ、取り込まずに受け口から消す", async () => {
      const userId = await activeUser();
      for (const [id, full, thumb] of [
        ["P1", new Uint8Array([0x3c, 0x68, 0x74]), jpegBytes()],
        ["P2", jpegBytes(), new Uint8Array([0x89, 0x50, 0x4e])],
      ] as const) {
        t.storage.put(photoKey("uploads", id, "full"), full, userId);
        t.storage.put(photoKey("uploads", id, "thumb"), thumb, userId);
        expect(await ingestUpload(t, photoKey("uploads", id, "full"))).toBe("ignored");
        expect(t.storage.get(photoKey("uploads", id, "full"))).toBeUndefined();
        expect(t.storage.get(photoKey("uploads", id, "thumb"))).toBeUndefined();
        expect(await t.repo.getPhoto(id)).toBeUndefined();
      }
      expect((await t.repo.getUser(userId))!.uploadCount).toBe(0);
    });
  });
});

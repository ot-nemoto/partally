import { describe, expect, it } from "vitest";
import { ingestUpload } from "./ingest.js";
import { photoKey } from "./photo-storage.js";
import { createClient, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("取り込み（ingestUpload）", () => {
    async function activeUser() {
      const token = await t.issueToken();
      const reg = await createClient(t.app)("POST", "/api/auth/register", { token, name: "田中" });
      return reg.body.user.userId as string;
    }

    it("対象外のキーは無視する", async () => {
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, "uploads/ID1/thumb.jpg")).toBe("ignored");
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, "photos/pending/ID1/full.jpg")).toBe("ignored");
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, "photos/approved/ID1/full.jpg")).toBe("ignored");
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, "other/file.jpg")).toBe("ignored");
    });

    it("サムネイルが無い・アップロード者が一致しない・ユーザが無効なら無視する", async () => {
      const userId = await activeUser();
      t.storage.put(photoKey("uploads", "P1", "full"), new Uint8Array([1]), userId);
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, photoKey("uploads", "P1", "full"))).toBe(
        "ignored",
      );

      t.storage.put(photoKey("uploads", "P1", "thumb"), new Uint8Array([1]), "someone-else");
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, photoKey("uploads", "P1", "full"))).toBe(
        "ignored",
      );

      t.storage.put(photoKey("uploads", "P2", "full"), new Uint8Array([1]), "ghost");
      t.storage.put(photoKey("uploads", "P2", "thumb"), new Uint8Array([1]), "ghost");
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, photoKey("uploads", "P2", "full"))).toBe(
        "ignored",
      );
    });

    it("同じイベントが重複して届いてもカウンタは 1 回だけ増える", async () => {
      const userId = await activeUser();
      t.storage.put(photoKey("uploads", "P1", "full"), new Uint8Array([1]), userId);
      t.storage.put(photoKey("uploads", "P1", "thumb"), new Uint8Array([1]), userId);
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, photoKey("uploads", "P1", "full"))).toBe(
        "created",
      );
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, photoKey("uploads", "P1", "full"))).toBe(
        "duplicate",
      );
      expect((await t.repo.getUser(userId))!.uploadCount).toBe(1);
    });
  });
});

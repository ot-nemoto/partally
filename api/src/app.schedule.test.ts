import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./repository.js";
import { createClient, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("スケジュール", () => {
    it("作成・更新・削除ができ、一覧は開始時刻の早い順", async () => {
      const admin = await t.adminClient();
      const toast = await admin("POST", "/api/admin/schedule", {
        title: " 乾杯 ",
        detail: "  幹事から一言\n  ",
        startMinute: 18 * 60 + 15,
        durationMinutes: 10,
      });
      expect(toast.status).toBe(201);
      expect(toast.body.item).toMatchObject({
        title: "乾杯",
        detail: "幹事から一言",
        startMinute: 1095,
        durationMinutes: 10,
      });
      await admin("POST", "/api/admin/schedule", {
        title: "開場",
        detail: "",
        startMinute: 18 * 60,
        durationMinutes: 15,
      });

      const list = await admin("GET", "/api/admin/schedule");
      expect(list.body.items.map((i: any) => i.title)).toEqual(["開場", "乾杯"]);
      expect(list.body.date).toBe("");

      // ドラッグで動かしたときと同じく、時刻と長さを変える
      const id = toast.body.item.itemId;
      const moved = await admin("PUT", `/api/admin/schedule/${id}`, {
        title: "乾杯",
        detail: "",
        startMinute: 17 * 60,
        durationMinutes: 20,
      });
      expect(moved.status).toBe(200);
      expect((await admin("GET", "/api/admin/schedule")).body.items.map((i: any) => i.title)).toEqual(["乾杯", "開場"]);

      expect((await admin("DELETE", `/api/admin/schedule/${id}`)).status).toBe(200);
      expect((await admin("DELETE", `/api/admin/schedule/${id}`)).status).toBe(404);
      expect(
        (
          await admin("PUT", `/api/admin/schedule/${id}`, {
            title: "x",
            detail: "",
            startMinute: 0,
            durationMinutes: 5,
          })
        ).status,
      ).toBe(404);
    });

    it("終わりが 24:00 を越える・5 分未満・長すぎる詳細は 400", async () => {
      const admin = await t.adminClient();
      const post = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/schedule", {
          title: "x",
          detail: "",
          startMinute: 600,
          durationMinutes: 30,
          ...body,
        });
      expect((await post({ startMinute: 23 * 60 + 45, durationMinutes: 30 })).status).toBe(400);
      expect((await post({ durationMinutes: 4 })).status).toBe(400);
      expect((await post({ startMinute: -5 })).status).toBe(400);
      expect((await post({ detail: "あ".repeat(501) })).status).toBe(400);
      expect((await post({ title: "" })).status).toBe(400);
    });

    it("参加者には見せる設定のときだけ、日付と一緒に返す", async () => {
      const admin = await t.adminClient();
      await admin("POST", "/api/admin/schedule", { title: "開場", detail: "", startMinute: 1080, durationMinutes: 15 });
      const token = await t.issueToken();
      const user = createClient(t.app);
      await user("POST", "/api/auth/register", { token, name: "参加者" });

      expect((await user("GET", "/api/schedule")).status).toBe(404);
      expect((await user("GET", "/api/admin/schedule")).status).toBe(401);

      expect(
        (await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, scheduleDate: "2026/12/20" })).status,
      ).toBe(400);
      await admin("PUT", "/api/admin/settings", {
        ...DEFAULT_SETTINGS,
        scheduleVisible: true,
        scheduleDate: "2026-12-20",
      });
      expect((await user("GET", "/api/me")).body.rules.scheduleVisible).toBe(true);
      const res = await user("GET", "/api/schedule");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ date: "2026-12-20", items: [{ title: "開場", startMinute: 1080 }] });
    });
  });
});

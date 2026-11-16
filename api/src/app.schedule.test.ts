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

    it("列は置いたまま。同じ列で重なったらすぐ右に列を足して移し、何もない列は詰める。列を超えて動かせる", async () => {
      const admin = await t.adminClient();
      const post = async (title: string, startMinute: number, column?: number) =>
        (await admin("POST", "/api/admin/schedule", { title, detail: "", startMinute, durationMinutes: 30, column }))
          .body.item;
      const columns = async () =>
        Object.fromEntries((await admin("GET", "/api/admin/schedule")).body.items.map((i: any) => [i.title, i.column]));
      const a = await post("A", 18 * 60);
      // 重ならなければ、左端の列のまま。別の列にも置ける
      await post("B", 18 * 60 + 30);
      const c = await post("C", 18 * 60, 1);
      expect(await columns()).toEqual({ A: 0, B: 0, C: 1 });
      // A と重なる D を左端の列に置くと、すぐ右に列を足して移す（もとの列 1 の C は列 2 へ）
      const d = await post("D", 18 * 60 + 15);
      expect(d.column).toBe(1);
      expect(await columns()).toEqual({ A: 0, B: 0, D: 1, C: 2 });
      // 列を超えて動かす（C を、空いている時間の列 0 の 19:00 へ）。何もなくなった列 2 は詰める
      const moved = await admin("PUT", `/api/admin/schedule/${c.itemId}`, {
        title: "C",
        detail: "",
        startMinute: 19 * 60,
        durationMinutes: 30,
        column: 0,
      });
      expect(moved.body.item.column).toBe(0);
      expect(await columns()).toEqual({ A: 0, B: 0, D: 1, C: 0 });
      // 列を省いて直すと、今の列のまま
      await admin("PUT", `/api/admin/schedule/${d.itemId}`, {
        title: "D2",
        detail: "",
        startMinute: 20 * 60,
        durationMinutes: 30,
      });
      expect(await columns()).toEqual({ A: 0, B: 0, C: 0, D2: 1 });
      // A を消しても、列 0 には B・C が残るので、D2 は列 1 のまま
      await admin("DELETE", `/api/admin/schedule/${a.itemId}`);
      expect(await columns()).toEqual({ B: 0, C: 0, D2: 1 });
    });

    it("何もない列を消すと、右の列が左へ詰まる", async () => {
      const admin = await t.adminClient();
      const post = async (title: string, column: number) =>
        (
          await admin("POST", "/api/admin/schedule", {
            title,
            detail: "",
            startMinute: 18 * 60,
            durationMinutes: 30,
            column,
          })
        ).body.item;
      const a = await post("A", 0);
      await post("B", 1);
      await post("C", 2);
      await admin("DELETE", `/api/admin/schedule/${a.itemId}`);
      const items = (await admin("GET", "/api/admin/schedule")).body.items;
      expect(Object.fromEntries(items.map((i: any) => [i.title, i.column]))).toEqual({ B: 0, C: 1 });
    });

    it("列を持つ前に作った項目は、時刻から決めた以前の並べ方の列で返し、次に直したときに保存する", async () => {
      const admin = await t.adminClient();
      const ts = "2026-01-01T00:00:00.000Z";
      await t.repo.createScheduleItem({
        itemId: "OLD1",
        title: "古い 1",
        detail: "",
        startMinute: 1080,
        durationMinutes: 60,
        createdAt: ts,
        updatedAt: ts,
      });
      await t.repo.createScheduleItem({
        itemId: "OLD2",
        title: "古い 2",
        detail: "",
        startMinute: 1110,
        durationMinutes: 60,
        createdAt: ts,
        updatedAt: ts,
      });
      const items = (await admin("GET", "/api/admin/schedule")).body.items;
      expect(items.map((i: any) => i.column)).toEqual([0, 1]);
      await admin("POST", "/api/admin/schedule", { title: "新", detail: "", startMinute: 1260, durationMinutes: 30 });
      expect((await t.repo.listScheduleItems()).map((i) => [i.itemId, i.column])).toContainEqual(["OLD2", 1]);
    });

    it("列は 0〜49 の整数", async () => {
      const admin = await t.adminClient();
      for (const column of [-1, 50, 1.5]) {
        const res = await admin("POST", "/api/admin/schedule", {
          title: "A",
          detail: "",
          startMinute: 0,
          durationMinutes: 30,
          column,
        });
        expect(res.status).toBe(400);
      }
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

    it("列ごとに参加者に見せないようにでき、置いた列に合わせる。参加者には見せない列を除いて詰めて返す", async () => {
      const admin = await t.adminClient();
      const post = async (title: string, startMinute: number, column: number, hidden?: boolean) =>
        (
          await admin("POST", "/api/admin/schedule", {
            title,
            detail: "",
            startMinute,
            durationMinutes: 30,
            column,
            hidden,
          })
        ).body.item;
      const state = async () =>
        Object.fromEntries(
          (await admin("GET", "/api/admin/schedule")).body.items.map((i: any) => [i.title, [i.column, i.hidden]]),
        );
      await post("A", 18 * 60, 0);
      const b = await post("B", 18 * 60, 1);
      await post("C", 18 * 60, 2);
      expect(b.hidden).toBe(false);

      // 列 1 を見せない
      const res = await admin("PUT", "/api/admin/schedule/columns/1", { hidden: true });
      expect(res.status).toBe(200);
      expect(res.body.items.find((i: any) => i.title === "B").hidden).toBe(true);
      expect(await state()).toEqual({ A: [0, false], B: [1, true], C: [2, false] });

      // 見せない列に作ると見せない。重なって右に足した列へ移っても見せないまま
      await post("D", 19 * 60, 1);
      await post("E", 18 * 60 + 10, 1);
      expect(await state()).toEqual({
        A: [0, false],
        B: [1, true],
        E: [2, true],
        C: [3, false],
        D: [1, true],
      });
      // 見せない列の項目を、見せる列へ動かすと見せる
      await admin("PUT", `/api/admin/schedule/${b.itemId}`, {
        title: "B",
        detail: "",
        startMinute: 20 * 60,
        durationMinutes: 30,
        column: 0,
      });
      expect((await state()).B).toEqual([0, false]);
      // 何もない列に置くときは、送った値（省けば今のまま）
      const f = await post("F", 21 * 60, 4, true);
      expect(f).toMatchObject({ column: 4, hidden: true });

      // 参加者には、見せない列（E の列・D の列・F の列）を除き、列を詰めて返す
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, scheduleVisible: true });
      const user = createClient(t.app);
      await user("POST", "/api/auth/register", { token: await t.issueToken(), name: "参加者" });
      const shown = (await user("GET", "/api/schedule")).body.items;
      expect(Object.fromEntries(shown.map((i: any) => [i.title, i.column]))).toEqual({ A: 0, B: 0, C: 1 });

      // 見せる列に戻す
      await admin("PUT", "/api/admin/schedule/columns/1", { hidden: false });
      expect((await state()).D).toEqual([1, false]);
    });

    it("列の切り替えは、項目のある列だけ。値は真偽", async () => {
      const admin = await t.adminClient();
      await admin("POST", "/api/admin/schedule", { title: "A", detail: "", startMinute: 0, durationMinutes: 30 });
      expect((await admin("PUT", "/api/admin/schedule/columns/1", { hidden: true })).status).toBe(404);
      expect((await admin("PUT", "/api/admin/schedule/columns/x", { hidden: true })).status).toBe(404);
      expect((await admin("PUT", "/api/admin/schedule/columns/0", { hidden: "yes" })).status).toBe(400);
      const user = createClient(t.app);
      await user("POST", "/api/auth/register", { token: await t.issueToken(), name: "参加者" });
      expect((await user("PUT", "/api/admin/schedule/columns/0", { hidden: true })).status).toBe(401);
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

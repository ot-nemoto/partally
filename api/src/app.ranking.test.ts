import { describe, expect, it } from "vitest";
import { buildRanking, toParticipantRanking } from "./app.js";
import { DEFAULT_SETTINGS, type UserRecord } from "./repository.js";

describe("buildRanking", () => {
  const user = (userId: string, name: string, counts: Partial<UserRecord> = {}): UserRecord => ({
    userId,
    name,
    epithet: "疾風の魔術師",
    status: "active",
    uploadCount: 0,
    approvedCount: 0,
    favoritesGiven: 0,
    favoritesReceived: 0,
    createdAt: `2026-01-01T00:00:0${userId.slice(1)}.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...counts,
  });
  /** クイズ形式のゲーム（確定は 2:00） */
  const quiz = (gameId = "Q1", status: "open" | "confirmed" = "confirmed") => ({
    gameId,
    format: "quiz" as const,
    name: "問題",
    description: "",
    status,
    slots: [],
    ranks: [],
    voterPoints: 0,
    choices: [
      { choiceId: "A", text: "a", points: 10 },
      { choiceId: "B", text: "b", points: 0 },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(status === "confirmed" ? { confirmedAt: "2026-01-01T02:00:00.000Z" } : {}),
  });
  const answer = (gameId: string, userId: string, choiceId: string, answeredAt: string) => ({
    gameId,
    userId,
    choiceId,
    answeredAt,
  });
  const photo = (photoId: string, uploaderId: string, createdAt: string, reviewedAt?: string) => ({
    photoId,
    uploaderId,
    status: "approved" as const,
    favoriteCount: 0,
    createdAt,
    reviewedAt,
  });

  it("写真は公開した時刻、お気に入りは選ばれた時刻（選んだ人も同じ時刻）、ゲームは確定した時刻に加え、同じ時刻はまとめる", () => {
    const result = buildRanking({
      users: [
        user("u1", "田中", { approvedCount: 2, favoritesReceived: 1 }),
        user("u2", "鈴木", { approvedCount: 0, favoritesGiven: 1 }),
        user("u3", "佐藤", { approvedCount: 1 }),
      ],
      settings: { ...DEFAULT_SETTINGS, uploadPoints: 2, favoritePoints: 3, favoriteGivenPoints: 5 },
      games: [
        {
          game: quiz(),
          answers: [
            answer("Q1", "u2", "A", "2026-01-01T01:59:00.000Z"),
            answer("Q1", "u3", "B", "2026-01-01T01:59:00.000Z"),
            // 確定の後に保存された答え（確定の直前に受け付けたもの）は数えない
            answer("Q1", "u1", "A", "2026-01-01T02:00:00.001Z"),
          ],
        },
        // 開催中のゲームは数えない
        { game: quiz("Q2", "open"), answers: [answer("Q2", "u1", "A", "2026-01-01T01:30:00.000Z")] },
      ],
      photos: [
        // 事前確認は承認した時刻
        photo("P1", "u1", "2026-01-01T00:10:00.000Z", "2026-01-01T00:20:00.000Z"),
        // 事後確認は投稿した時刻
        photo("P2", "u1", "2026-01-01T00:20:00.000Z"),
        photo("P3", "u3", "2026-01-01T00:30:00.000Z"),
      ],
      favorites: [
        { userId: "u2", photoId: "P2", createdAt: "2026-01-01T01:00:00.000Z" },
        // 公開中でない写真へのお気に入り（削除の後片付けの途中など）は、選んだ人にも数えない
        { userId: "u3", photoId: "PX", createdAt: "2026-01-01T01:30:00.000Z" },
      ],
      now: "2026-01-01T03:00:00.000Z",
    });

    expect(result.generatedAt).toBe("2026-01-01T03:00:00.000Z");
    expect(result.ranking.map((r) => [r.rank, r.userId, r.points])).toEqual([
      [1, "u2", 15],
      [2, "u1", 7],
      [3, "u3", 2],
    ]);
    expect(result.ranking[1]!.history).toEqual([
      { at: "2026-01-01T00:00:01.000Z", points: 0 },
      { at: "2026-01-01T00:20:00.000Z", points: 4 },
      { at: "2026-01-01T01:00:00.000Z", points: 7 },
      { at: "2026-01-01T03:00:00.000Z", points: 7 },
    ]);
    expect(result.ranking[0]!.history).toEqual([
      { at: "2026-01-01T00:00:02.000Z", points: 0 },
      { at: "2026-01-01T01:00:00.000Z", points: 5 },
      { at: "2026-01-01T02:00:00.000Z", points: 15 },
      { at: "2026-01-01T03:00:00.000Z", points: 15 },
    ]);
    // 0 点の選択肢は点を増やさない
    expect(result.ranking[2]!.history.map((h) => h.points)).toEqual([0, 2, 2]);
  });

  it("合計も項目のポイントも同じ人は、登録順（先に登録した人が上）で別の順位にする", () => {
    const result = buildRanking({
      users: [user("u3", "佐藤"), user("u1", "田中", { approvedCount: 1 }), user("u2", "鈴木", { approvedCount: 1 })],
      settings: DEFAULT_SETTINGS,
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    });
    expect(result.ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [2, "u2"],
      [3, "u3"],
    ]);
    // 推移の元データが無くても、最後の点はユーザのカウンタから計算したポイント
    expect(result.ranking[0]!.history.at(-1)).toEqual({ at: "2026-01-01T03:00:00.000Z", points: 1 });
  });

  it("確定したゲームの点数は合計に入り、同じポイントのときの項目としても比べる（下書きは数えない）", () => {
    const game = (status: "draft" | "confirmed", userIds: string[]) => ({
      gameId: `G-${status}`,
      format: "result" as const,
      name: "大会",
      description: "",
      status,
      slots: [{ slotId: "S1", name: "優勝", points: 10, userIds }],
      choices: [],
      ranks: [],
      voterPoints: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...(status === "confirmed" ? { confirmedAt: "2026-01-01T02:00:00.000Z" } : {}),
    });
    const rank = (order: typeof DEFAULT_SETTINGS.tieBreakOrder) =>
      buildRanking({
        // u1 は写真で 10 点、u2 はゲームで 10 点（u3 は下書きのゲームだけなので 0 点）
        users: [user("u1", "田中", { approvedCount: 10 }), user("u2", "鈴木"), user("u3", "佐藤")],
        settings: { ...DEFAULT_SETTINGS, uploadPoints: 1, tieBreakOrder: order },
        photos: [],
        favorites: [],
        games: [game("confirmed", ["u2"]), game("draft", ["u3"])].map((g) => ({ game: g, answers: [] })),
        now: "2026-01-01T03:00:00.000Z",
      }).ranking;
    const byDefault = rank(DEFAULT_SETTINGS.tieBreakOrder);
    expect(byDefault.map((r) => [r.rank, r.userId, r.points])).toEqual([
      [1, "u1", 10],
      [2, "u2", 10],
      [3, "u3", 0],
    ]);
    expect(byDefault[1]!.history).toEqual([
      { at: "2026-01-01T00:00:02.000Z", points: 0 },
      { at: "2026-01-01T02:00:00.000Z", points: 10 },
      { at: "2026-01-01T03:00:00.000Z", points: 10 },
    ]);
    expect(rank(["game", "upload", "favoriteGiven", "favoriteReceived", "registered"]).map((r) => r.userId)).toEqual([
      "u2",
      "u1",
      "u3",
    ]);
  });

  it("登録の時刻まで同じ人も、ユーザ ID の順で別の順位にする", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const result = buildRanking({
      users: [user("u2", "鈴木", { createdAt: at }), user("u1", "田中", { createdAt: at })],
      settings: DEFAULT_SETTINGS,
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    });
    expect(result.ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [2, "u2"],
    ]);
  });

  // 合計はどちらも 10 点。u1 は写真で 10 点、u2 はお気に入りを選んで 10 点、u3 はゲーム（クイズ形式）で 10 点
  const tied = () => [
    user("u1", "田中", { approvedCount: 10 }),
    user("u2", "鈴木", { favoritesGiven: 1 }),
    user("u3", "佐藤"),
  ];
  const quizFor = (userId: string) => [
    { game: quiz(), answers: [answer("Q1", userId, "A", "2026-01-01T01:00:00.000Z")] },
  ];
  const rankOf = (settings: typeof DEFAULT_SETTINGS) =>
    buildRanking({
      users: tied(),
      settings: { ...settings, uploadPoints: 1, favoriteGivenPoints: 10 },
      games: quizFor("u3"),
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    }).ranking.map((r) => [r.rank, r.userId, r.points]);

  it("同じポイントは、既定では写真のアップロード → お気に入りを選んだ → 選ばれた → ゲームの順に比べ、順位も分ける", () => {
    expect(rankOf(DEFAULT_SETTINGS)).toEqual([
      [1, "u1", 10],
      [2, "u2", 10],
      [3, "u3", 10],
    ]);
  });

  it("優先順を並べ替えると、その順に比べる", () => {
    expect(
      rankOf({
        ...DEFAULT_SETTINGS,
        tieBreakOrder: ["game", "favoriteGiven", "upload", "favoriteReceived", "registered"],
      }),
    ).toEqual([
      [1, "u3", 10],
      [2, "u2", 10],
      [3, "u1", 10],
    ]);
  });

  it("登録順を先頭にすると、ポイントの項目より先に登録順で比べる", () => {
    // 合計はどちらも 10 点。先に登録した u1 はゲームで、u2 は写真で 10 点
    const rank = (tieBreakOrder: typeof DEFAULT_SETTINGS.tieBreakOrder) =>
      buildRanking({
        users: [user("u2", "鈴木", { approvedCount: 10 }), user("u1", "田中")],
        settings: { ...DEFAULT_SETTINGS, uploadPoints: 1, tieBreakOrder },
        games: quizFor("u1"),
        photos: [],
        favorites: [],
        now: "2026-01-01T03:00:00.000Z",
      }).ranking.map((r) => [r.rank, r.userId]);
    expect(rank(DEFAULT_SETTINGS.tieBreakOrder)).toEqual([
      [1, "u2"],
      [2, "u1"],
    ]);
    expect(rank(["registered", "upload", "favoriteGiven", "favoriteReceived", "game"])).toEqual([
      [1, "u1"],
      [2, "u2"],
    ]);
  });

  it("参加者向けに紐づけを解除した人を除くと、並び順のとおりに 1 位から付け直す", () => {
    const ranking = buildRanking({
      users: [
        user("u1", "田中", { approvedCount: 10 }),
        user("u2", "鈴木", { approvedCount: 10, status: "unbound" }),
        user("u3", "佐藤", { approvedCount: 10 }),
        user("u4", "高橋", { favoritesGiven: 1 }),
      ],
      settings: { ...DEFAULT_SETTINGS, uploadPoints: 1, favoriteGivenPoints: 10 },
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    });
    expect(ranking.ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [2, "u2"],
      [3, "u3"],
      [4, "u4"],
    ]);
    expect(toParticipantRanking(ranking, false, false).ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [2, "u3"],
      [3, "u4"],
    ]);
  });
});

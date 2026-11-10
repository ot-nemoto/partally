import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { DynamoRepository } from "./dynamo-repository.js";
import {
  DEFAULT_SETTINGS,
  EpithetTakenError,
  FavoriteLimitError,
  GameAlreadyOpenError,
  InvalidStateError,
  NotFoundError,
  type PhotoRecord,
  type PrizeRecord,
  TokenNotAvailableError,
  type UserRecord,
} from "./repository.js";

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new DynamoRepository(DynamoDBDocumentClient.from(new DynamoDBClient({})), "table");

const user: UserRecord & { token: string } = {
  userId: "u1",
  name: "田中",
  epithet: "疾風の魔術師",
  token: "t".repeat(22),
  status: "active",
  uploadCount: 0,
  approvedCount: 0,
  favoritesGiven: 0,
  favoritesReceived: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function canceled(codes: string[]) {
  return new TransactionCanceledException({
    message: "canceled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

describe("DynamoRepository", () => {
  beforeEach(() => ddb.reset());

  describe("設定", () => {
    it("保存済みの優先順は、知らない項目（以前あった quiz など）・重複を除き、足りない項目を既定の順で補う（登録順は最後）", async () => {
      ddb.on(GetCommand).resolves({ Item: { tieBreakOrder: ["favoriteReceived", "quiz", "x", "upload", "upload"] } });
      expect((await repo.getSettings()).tieBreakOrder).toEqual([
        "favoriteReceived",
        "upload",
        "favoriteGiven",
        "game",
        "registered",
      ]);
    });

    it("登録順を保存済みなら、足りないポイントの項目（後から加えたゲームなど）は登録順の前に入れる", async () => {
      ddb.on(GetCommand).resolves({
        Item: { tieBreakOrder: ["favoriteGiven", "registered", "upload", "favoriteReceived"] },
      });
      expect((await repo.getSettings()).tieBreakOrder).toEqual([
        "favoriteGiven",
        "game",
        "registered",
        "upload",
        "favoriteReceived",
      ]);
    });

    it("保存されていない項目は既定値で補う", async () => {
      ddb.on(GetCommand).resolves({ Item: { moderation: "post", uploadPoints: 3 } });
      expect(await repo.getSettings()).toEqual({ ...DEFAULT_SETTINGS, moderation: "post", uploadPoints: 3 });
    });
  });

  describe("registerUser", () => {
    it("トークン紐づけ・ユーザ作成・二つ名ロックを 1 トランザクションで書く", async () => {
      ddb.on(TransactWriteCommand).resolves({});
      await repo.registerUser(user);

      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Update).toMatchObject({
        Key: { PK: `TOKEN#${user.token}`, SK: "META" },
        ConditionExpression: "#status = :unbound",
      });
      expect(items[1]!.Put).toMatchObject({
        Item: { PK: "USER#u1", SK: "PROFILE", GSI1PK: "USERS", name: "田中" },
        ConditionExpression: "attribute_not_exists(PK)",
      });
      expect(items[2]!.Put).toMatchObject({
        Item: { PK: "EPITHET#疾風の魔術師", SK: "LOCK", userId: "u1" },
      });
    });

    it("同時登録で TransactionConflict により取り消されたら再実行し、成功すれば登録できる", async () => {
      ddb
        .on(TransactWriteCommand)
        .rejectsOnce(canceled(["TransactionConflict", "None", "None"]))
        .resolves({});
      await repo.registerUser(user);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
    });

    it("再実行で先の登録が済んでいれば、トークンの条件チェックに失敗して TokenNotAvailableError", async () => {
      ddb
        .on(TransactWriteCommand)
        .rejectsOnce(canceled(["TransactionConflict", "None", "None"]))
        .rejects(canceled(["ConditionalCheckFailed", "None", "None"]));
      await expect(repo.registerUser(user)).rejects.toBeInstanceOf(TokenNotAvailableError);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
    });

    it("同じ二つ名の取り合いで取り消された後、再実行で二つ名の条件チェックに失敗すると EpithetTakenError", async () => {
      ddb
        .on(TransactWriteCommand)
        .rejectsOnce(canceled(["None", "None", "TransactionConflict"]))
        .rejects(canceled(["None", "None", "ConditionalCheckFailed"]));
      await expect(repo.registerUser(user)).rejects.toBeInstanceOf(EpithetTakenError);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
    });

    it("取り消され続けたら回数を限って諦め、例外のまま投げる", async () => {
      ddb.on(TransactWriteCommand).rejects(canceled(["TransactionConflict", "None", "None"]));
      await expect(repo.registerUser(user)).rejects.toBeInstanceOf(TransactionCanceledException);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(5);
    });

    it("トークンの条件チェック失敗は TokenNotAvailableError", async () => {
      ddb.on(TransactWriteCommand).rejects(canceled(["ConditionalCheckFailed", "None", "None"]));
      await expect(repo.registerUser(user)).rejects.toBeInstanceOf(TokenNotAvailableError);
    });

    it("二つ名ロックの条件チェック失敗は EpithetTakenError", async () => {
      ddb.on(TransactWriteCommand).rejects(canceled(["None", "None", "ConditionalCheckFailed"]));
      await expect(repo.registerUser(user)).rejects.toBeInstanceOf(EpithetTakenError);
    });
  });

  describe("createTokens", () => {
    it("カウンタから通し番号を採番し、25 件ずつ書き込む", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: { value: 40 } });
      ddb.on(BatchWriteCommand).resolves({});

      const tokens = Array.from({ length: 30 }, (_, i) => `token-${i}`);
      const records = await repo.createTokens(tokens, "2026-01-01T00:00:00.000Z");

      expect(records[0]!.label).toBe("011");
      expect(records[29]!.label).toBe("040");
      const batches = ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.table!);
      expect(batches.map((b) => b.length)).toEqual([25, 5]);
      expect(batches[0]![0]!.PutRequest!.Item).toMatchObject({ GSI1PK: "TOKENS", GSI1SK: "000011" });
    });

    it("未処理分を再送する", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: { value: 1 } });
      const unprocessed = [{ PutRequest: { Item: { PK: "TOKEN#x" } } }];
      ddb
        .on(BatchWriteCommand)
        .resolvesOnce({ UnprocessedItems: { table: unprocessed } })
        .resolves({});

      await repo.createTokens(["x"], "2026-01-01T00:00:00.000Z");
      const calls = ddb.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.args[0].input.RequestItems!.table).toEqual(unprocessed);
    });
  });

  describe("写真", () => {
    const photo: PhotoRecord = {
      photoId: "P1",
      uploaderId: "u1",
      status: "pending",
      favoriteCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    it("createPhoto は写真の作成とアップロード数の加算を 1 トランザクションで行い、重複は false", async () => {
      ddb
        .on(TransactWriteCommand)
        .resolvesOnce({})
        .rejectsOnce(canceled(["ConditionalCheckFailed", "None"]));
      expect(await repo.createPhoto(photo)).toBe(true);
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Put!.Item).toMatchObject({
        PK: "PHOTO#P1",
        GSI1PK: "PHOTOS#pending",
        GSI1SK: "2026-01-01T00:00:00.000Z#P1",
        GSI2PK: "USER#u1",
      });
      expect(items[1]!.Update!.UpdateExpression).toBe("ADD uploadCount :one");

      expect(await repo.createPhoto(photo)).toBe(false);
    });

    it("同じユーザのカウンタへの同時更新で取り消されても再実行する（どのトランザクションも同じ）", async () => {
      ddb
        .on(TransactWriteCommand)
        .rejectsOnce(canceled(["None", "TransactionConflict"]))
        .resolves({});
      expect(await repo.createPhoto(photo)).toBe(true);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
    });

    it("即時公開の写真は approvedCount も加算する", async () => {
      ddb.on(TransactWriteCommand).resolves({});
      await repo.createPhoto({ ...photo, status: "approved" });
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[1]!.Update!.UpdateExpression).toBe("ADD uploadCount :one, approvedCount :one");
    });

    it("承認は状態と GSI を更新し approvedCount を加算する。pending 以外は InvalidStateError", async () => {
      ddb.on(GetCommand).resolves({ Item: { ...photo } });
      ddb.on(TransactWriteCommand).resolves({});
      const approved = await repo.approvePhoto("P1", "2026-01-02T00:00:00.000Z");
      expect(approved.status).toBe("approved");
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Update!.ExpressionAttributeValues).toMatchObject({ ":gsi1pk": "PHOTOS#approved" });
      expect(items[1]!.Update).toMatchObject({
        UpdateExpression: "ADD approvedCount :approvedCount",
        ExpressionAttributeValues: { ":approvedCount": 1 },
      });

      ddb.on(GetCommand).resolves({ Item: { ...photo, status: "approved" } });
      await expect(repo.approvePhoto("P1", "x")).rejects.toBeInstanceOf(InvalidStateError);
    });

    it("一覧は新しい順で、続きはカーソルで受け渡す", async () => {
      const lastKey = { PK: "PHOTO#P1", SK: "META", GSI1PK: "PHOTOS#approved", GSI1SK: "x" };
      ddb
        .on(QueryCommand)
        .resolvesOnce({ Items: [{ ...photo, status: "approved" }], LastEvaluatedKey: lastKey })
        .resolvesOnce({ Items: [] });
      const page = await repo.listPhotosByStatus("approved", 30);
      expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
        IndexName: "GSI1",
        ScanIndexForward: false,
        Limit: 30,
      });

      await repo.listPhotosByStatus("approved", 30, page.cursor);
      expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual(lastKey);
    });
  });

  describe("削除", () => {
    it("公開済みの写真は記録を残したまま deleted にし、両方のカウンタを減らす", async () => {
      ddb.on(GetCommand).resolves({
        Item: { photoId: "P1", uploaderId: "u1", status: "approved", createdAt: "2026-01-01T00:00:00.000Z" },
      });
      ddb.on(TransactWriteCommand).resolves({});
      const deleted = await repo.deleteApprovedPhoto("P1", "2026-01-02T00:00:00.000Z");
      expect(deleted.status).toBe("deleted");
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Update!.ExpressionAttributeValues).toMatchObject({ ":to": "deleted", ":from": "approved" });
      expect(items[1]!.Update).toMatchObject({
        UpdateExpression: "ADD uploadCount :uploadCount, approvedCount :approvedCount",
        ExpressionAttributeValues: { ":uploadCount": -1, ":approvedCount": -1 },
      });
    });
  });

  describe("お気に入り", () => {
    const photo: PhotoRecord = {
      photoId: "P1",
      uploaderId: "u2",
      status: "approved",
      favoriteCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    it("お気に入りの作成と 3 つのカウンタの加算を 1 トランザクションで行い、上限は条件で守る", async () => {
      ddb.on(TransactWriteCommand).resolves({});
      await repo.addFavorite("u1", photo, 10, "2026-01-02T00:00:00.000Z");
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Put!.Item).toMatchObject({ PK: "USER#u1", SK: "FAV#P1", GSI1PK: "FAVS#P1" });
      expect(items[1]!.Update).toMatchObject({
        Key: { PK: "USER#u1", SK: "PROFILE" },
        UpdateExpression: "ADD favoritesGiven :one",
        ExpressionAttributeValues: { ":one": 1, ":limit": 10 },
      });
      expect(items[2]!.Update).toMatchObject({ Key: { PK: "PHOTO#P1" }, UpdateExpression: "ADD favoriteCount :one" });
      expect(items[3]!.Update).toMatchObject({
        Key: { PK: "USER#u2", SK: "PROFILE" },
        UpdateExpression: "ADD favoritesReceived :one",
      });
    });

    it("条件チェックの失敗箇所で、選択済み・上限・公開中でないを分ける", async () => {
      ddb
        .on(TransactWriteCommand)
        .rejectsOnce(canceled(["ConditionalCheckFailed", "None", "None", "None"]))
        .rejectsOnce(canceled(["None", "ConditionalCheckFailed", "None", "None"]))
        .rejectsOnce(canceled(["None", "None", "ConditionalCheckFailed", "None"]));
      await expect(repo.addFavorite("u1", photo, 10, "x")).resolves.toBeUndefined();
      await expect(repo.addFavorite("u1", photo, 10, "x")).rejects.toBeInstanceOf(FavoriteLimitError);
      await expect(repo.addFavorite("u1", photo, 10, "x")).rejects.toBeInstanceOf(InvalidStateError);
    });

    it("上限 0 なら（選択数の属性が無いユーザでも）選べない", async () => {
      await expect(repo.addFavorite("u1", photo, 0, "x")).rejects.toBeInstanceOf(FavoriteLimitError);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("アップロード者のユーザが無ければ選べない（ユーザのアイテムを作らない）", async () => {
      ddb.on(TransactWriteCommand).rejects(canceled(["None", "None", "None", "ConditionalCheckFailed"]));
      await expect(repo.addFavorite("u1", photo, 10, "x")).rejects.toBeInstanceOf(InvalidStateError);
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[3]!.Update!.ConditionExpression).toBe("attribute_exists(PK)");
    });

    it("同時更新で取り消されたら再実行する", async () => {
      ddb
        .on(TransactWriteCommand)
        .rejectsOnce(canceled(["None", "None", "TransactionConflict", "None"]))
        .rejectsOnce(canceled(["None", "None", "None", "TransactionConflict"]))
        .resolves({});
      await repo.addFavorite("u1", photo, 10, "x");
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(3);
    });

    it("写真のお気に入りをすべて外す。一覧に出ていない分があれば取り直す", async () => {
      ddb
        .on(GetCommand)
        .resolvesOnce({ Item: { PK: "PHOTO#P1", SK: "META", ...photo, status: "deleted", favoriteCount: 2 } })
        .resolvesOnce({ Item: { PK: "PHOTO#P1", SK: "META", ...photo, status: "deleted", favoriteCount: 1 } })
        .resolves({ Item: { PK: "PHOTO#P1", SK: "META", ...photo, status: "deleted", favoriteCount: 0 } });
      ddb
        .on(QueryCommand)
        .resolvesOnce({ Items: [{ userId: "u1" }] })
        .resolves({ Items: [{ userId: "u3" }] });
      ddb.on(TransactWriteCommand).resolves({});
      await repo.clearFavorites("P1");
      expect(ddb.commandCalls(GetCommand).every((c) => c.args[0].input.ConsistentRead)).toBe(true);
      expect(ddb.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems![0]!.Delete!.Key)).toEqual(
        [
          { PK: "USER#u1", SK: "FAV#P1" },
          { PK: "USER#u3", SK: "FAV#P1" },
        ],
      );
    });

    it("写真ごとのお気に入りを、選んだ人と時刻つきで返す", async () => {
      ddb.on(QueryCommand).resolves({
        Items: [{ userId: "u1", photoId: "P1", createdAt: "2026-01-02T00:00:00.000Z" }],
      });
      expect(await repo.listFavoritesOfPhoto("P1")).toEqual([
        { userId: "u1", photoId: "P1", createdAt: "2026-01-02T00:00:00.000Z" },
      ]);
      expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
        IndexName: "GSI1",
        ExpressionAttributeValues: { ":pk": "FAVS#P1" },
      });
    });

    it("自分の写真は選べない", async () => {
      await expect(repo.addFavorite("u2", photo, 10, "x")).rejects.toBeInstanceOf(InvalidStateError);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("外すときは 3 つのカウンタを減らし、選んでいなければ何もしない", async () => {
      ddb
        .on(TransactWriteCommand)
        .resolvesOnce({})
        .rejectsOnce(canceled(["ConditionalCheckFailed", "None", "None", "None"]));
      await repo.removeFavorite("u1", photo);
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Delete).toMatchObject({ Key: { PK: "USER#u1", SK: "FAV#P1" } });
      expect(items.slice(1).map((i) => i.Update!.UpdateExpression)).toEqual([
        "ADD favoritesGiven :minus",
        "ADD favoriteCount :minus",
        "ADD favoritesReceived :minus",
      ]);
      await expect(repo.removeFavorite("u1", photo)).resolves.toBeUndefined();
    });
  });

  describe("スケジュール", () => {
    it("作成順に並べるため GSI1 に入れ、無い項目の更新・削除は NotFoundError", async () => {
      ddb.on(PutCommand).resolves({});
      const item = {
        itemId: "S1",
        title: "乾杯",
        detail: "",
        startMinute: 1095,
        durationMinutes: 10,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      await repo.createScheduleItem(item);
      expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
        Item: { PK: "SCHEDULE#S1", SK: "META", GSI1PK: "SCHEDULE", GSI1SK: "2026-01-01T00:00:00.000Z#S1" },
        ConditionExpression: "attribute_not_exists(PK)",
      });
      ddb.on(QueryCommand).resolves({ Items: [{ PK: "SCHEDULE#S1", SK: "META", ...item }] });
      expect(await repo.listScheduleItems()).toEqual([item]);

      const failed = new ConditionalCheckFailedException({ message: "failed", $metadata: {} });
      ddb.on(UpdateCommand).rejects(failed);
      await expect(
        repo.updateScheduleItem("S1", { title: "x", detail: "", startMinute: 0, durationMinutes: 5 }, "t"),
      ).rejects.toBeInstanceOf(NotFoundError);
      ddb.on(DeleteCommand).rejects(failed);
      await expect(repo.deleteScheduleItem("S1")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("ゲーム", () => {
    const game = {
      gameId: "G1",
      format: "result" as const,
      name: "大会",
      description: "",
      status: "draft" as const,
      slots: [{ slotId: "S1", name: "優勝", points: 30, userIds: ["U1"] }],
      choices: [],
      ranks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    };
    const gameItem = (status: string) => ({ PK: "GAME#G1", SK: "META", ...game, status });
    const changes = { name: "大会", description: "", slots: game.slots, choices: [], ranks: [] };

    it("版を渡すと、保存済みの updatedAt が同じときだけ更新する。違えば InvalidStateError、無ければ NotFoundError", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: { ...gameItem("draft"), updatedAt: "t2" } });
      await repo.updateGame("G1", changes, "t2", game.updatedAt);
      expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
        ConditionExpression: "attribute_exists(PK) AND updatedAt = :expected",
        ExpressionAttributeValues: { ":expected": game.updatedAt },
      });
      await repo.updateGame("G1", changes, "t3");
      expect(ddb.commandCalls(UpdateCommand)[1]!.args[0].input.ConditionExpression).toBe("attribute_exists(PK)");
      // 画像・正解の数が無ければ消し、あれば付ける（0 も正解の数として付ける）
      expect(ddb.commandCalls(UpdateCommand)[1]!.args[0].input.UpdateExpression).toMatch(
        / REMOVE imageId, correctNumber$/,
      );
      await repo.updateGame("G1", { ...changes, imageId: "IMG1", correctNumber: 0 }, "t3");
      expect(ddb.commandCalls(UpdateCommand)[2]!.args[0].input).toMatchObject({
        UpdateExpression: expect.stringMatching(/, imageId = :imageId, correctNumber = :correctNumber$/),
        ExpressionAttributeValues: { ":imageId": "IMG1", ":correctNumber": 0, ":ranks": [] },
      });

      const failed = new ConditionalCheckFailedException({ message: "failed", $metadata: {} });
      ddb.on(UpdateCommand).rejects(failed);
      ddb.on(GetCommand).resolves({ Item: gameItem("draft") });
      await expect(repo.updateGame("G1", changes, "t4", "old")).rejects.toBeInstanceOf(InvalidStateError);
      ddb.on(GetCommand).resolves({});
      await expect(repo.updateGame("G1", changes, "t4", "old")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("形式を持つ前に作ったゲームは、結果入力として読む", async () => {
      const { format: _f, description: _d, choices: _c, ...old } = game;
      ddb.on(GetCommand).resolves({ Item: { PK: "GAME#G1", SK: "META", ...old } });
      expect(await repo.getGame("G1")).toMatchObject({ format: "result", description: "", choices: [] });
    });

    it("開催は「開催中」の印と状態の変更を 1 トランザクションで行い、別のゲームが開催中なら断る", async () => {
      ddb
        .on(TransactWriteCommand)
        .resolvesOnce({})
        .rejectsOnce(canceled(["ConditionalCheckFailed", "None"]))
        .rejectsOnce(canceled(["None", "ConditionalCheckFailed"]))
        .rejectsOnce(canceled(["ConditionalCheckFailed", "ConditionalCheckFailed"]));
      ddb
        .on(GetCommand)
        .resolvesOnce({ Item: gameItem("open") })
        .resolvesOnce({ Item: gameItem("draft") })
        .resolvesOnce({ Item: gameItem("confirmed") })
        .resolvesOnce({});

      expect((await repo.changeGameStatus("G1", "draft", "open", "2026-01-01T00:01:00.000Z")).status).toBe("open");
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Put).toMatchObject({
        Item: { PK: "GAME_STATE", SK: "OPEN", gameId: "G1" },
        ConditionExpression: "attribute_not_exists(PK)",
      });
      expect(items[1]!.Update).toMatchObject({
        Key: { PK: "GAME#G1", SK: "META" },
        UpdateExpression: "SET #status = :to, updatedAt = :at, openedAt = :at",
        ConditionExpression: "#status = :from",
        ExpressionAttributeValues: { ":to": "open", ":from": "draft" },
      });

      await expect(repo.changeGameStatus("G1", "draft", "open", "x")).rejects.toBeInstanceOf(GameAlreadyOpenError);
      await expect(repo.changeGameStatus("G1", "draft", "open", "x")).rejects.toBeInstanceOf(InvalidStateError);
      await expect(repo.changeGameStatus("G1", "draft", "open", "x")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("開催中から変えるときは、そのゲームの印を消す。確定は confirmedAt を付け、確定から戻すと消す", async () => {
      ddb.on(TransactWriteCommand).resolves({});
      ddb.on(UpdateCommand).resolves({});
      ddb.on(GetCommand).resolves({ Item: gameItem("confirmed") });
      await repo.changeGameStatus("G1", "open", "confirmed", "t1");
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Delete).toMatchObject({
        Key: { PK: "GAME_STATE", SK: "OPEN" },
        ConditionExpression: "gameId = :gameId",
        ExpressionAttributeValues: { ":gameId": "G1" },
      });
      expect(items[1]!.Update!.UpdateExpression).toBe("SET #status = :to, updatedAt = :at, confirmedAt = :at");

      // 開催中を通らない変更は、ゲームのアイテムだけ
      await repo.changeGameStatus("G1", "confirmed", "draft", "t2");
      expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
        UpdateExpression: "SET #status = :to, updatedAt = :at REMOVE confirmedAt",
        ExpressionAttributeValues: { ":to": "draft", ":from": "confirmed" },
      });
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    it("答えはユーザの下に保存する（ゲームを含むトランザクションにはしない）", async () => {
      ddb.on(PutCommand).resolves({});
      await repo.putGameAnswer({ gameId: "G1", userId: "u1", choiceId: "A", answeredAt: "2026-01-01T00:01:30.000Z" });
      expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({
        PK: "USER#u1",
        SK: "GANSWER#G1",
        GSI1PK: "GANSWERS#G1",
        choiceId: "A",
      });
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("削除は開催中でなければゲームを消し、その答えもまとめて消す", async () => {
      ddb.on(DeleteCommand).resolves({});
      ddb.on(QueryCommand).resolves({
        Items: [
          { gameId: "G1", userId: "u1", choiceId: "A", answeredAt: "x" },
          { gameId: "G1", userId: "u2", choiceId: "B", answeredAt: "x" },
        ],
      });
      ddb.on(BatchWriteCommand).resolves({});
      await repo.deleteGame("G1");
      expect(ddb.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({
        Key: { PK: "GAME#G1", SK: "META" },
        ConditionExpression: "attribute_exists(PK) AND #status <> :open",
      });
      expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
        IndexName: "GSI1",
        ExpressionAttributeValues: { ":pk": "GANSWERS#G1" },
      });
      const deletes = ddb.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems!.table!;
      expect(deletes.map((d) => d.DeleteRequest!.Key)).toEqual([
        { PK: "USER#u1", SK: "GANSWER#G1" },
        { PK: "USER#u2", SK: "GANSWER#G1" },
      ]);

      const failed = new ConditionalCheckFailedException({ message: "failed", $metadata: {} });
      ddb.on(DeleteCommand).rejects(failed);
      ddb.on(GetCommand).resolves({ Item: gameItem("open") });
      await expect(repo.deleteGame("G1")).rejects.toBeInstanceOf(InvalidStateError);
    });
  });

  describe("景品", () => {
    const prize: PrizeRecord = {
      prizeId: "P1",
      name: "TV",
      quantity: 2,
      positions: [1, 3],
      imageId: "I1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("作成順に並べるため GSI1 に入れ、一覧は GSI1 から読む", async () => {
      ddb.on(PutCommand).resolves({});
      await repo.createPrize(prize);
      expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
        Item: {
          PK: "PRIZE#P1",
          SK: "META",
          GSI1PK: "PRIZES",
          GSI1SK: "2026-01-01T00:00:00.000Z#P1",
          positions: [1, 3],
        },
        ConditionExpression: "attribute_not_exists(PK)",
      });
      ddb.on(QueryCommand).resolves({ Items: [{ PK: "PRIZE#P1", SK: "META", ...prize }] });
      expect(await repo.listPrizes()).toEqual([prize]);
    });

    it("画像を外す更新は imageId を消し、無い景品の更新・削除は NotFoundError", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: { ...prize, imageId: undefined, name: "テレビ" } });
      const updated = await repo.updatePrize("P1", { name: "テレビ", quantity: 2, positions: [1] }, "t");
      expect(updated.imageId).toBeUndefined();
      expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input.UpdateExpression).toMatch(/ REMOVE imageId$/);

      const failed = new ConditionalCheckFailedException({ message: "failed", $metadata: {} });
      ddb.on(UpdateCommand).rejects(failed);
      await expect(repo.updatePrize("P1", { name: "x", quantity: 1, positions: [] }, "t")).rejects.toBeInstanceOf(
        NotFoundError,
      );
      ddb.on(DeleteCommand).rejects(failed);
      await expect(repo.deletePrize("P1")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("設定", () => {
    it("保存されていない項目は既定値で補う", async () => {
      ddb.on(GetCommand).resolves({ Item: { PK: "SETTINGS", SK: "GLOBAL", moderation: "post" } });
      expect(await repo.getSettings()).toEqual({ ...DEFAULT_SETTINGS, moderation: "post" });
    });
  });
});

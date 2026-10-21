import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
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
  InvalidStateError,
  type PhotoRecord,
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

  describe("設定", () => {
    it("保存されていない項目は既定値で補う", async () => {
      ddb.on(GetCommand).resolves({ Item: { PK: "SETTINGS", SK: "GLOBAL", moderation: "post" } });
      expect(await repo.getSettings()).toEqual({ ...DEFAULT_SETTINGS, moderation: "post" });
    });
  });
});

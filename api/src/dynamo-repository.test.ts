import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
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
  InvalidStateError,
  NotFoundError,
  type PhotoRecord,
  QuizAlreadyOpenError,
  type QuizRecord,
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

  describe("クイズ", () => {
    const quiz: QuizRecord = {
      quizId: "Q1",
      text: "問題",
      choices: [
        { choiceId: "A", text: "a", points: 10 },
        { choiceId: "B", text: "b", points: 0 },
      ],
      status: "draft",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const quizItem = (status: QuizRecord["status"]) => ({ PK: "QUIZ#Q1", SK: "META", ...quiz, status });

    it("出題は「出題中」の印と状態の変更を 1 トランザクションで行い、別の問題が出題中なら断る", async () => {
      ddb
        .on(TransactWriteCommand)
        .resolvesOnce({})
        .rejectsOnce(canceled(["ConditionalCheckFailed", "None"]))
        .rejectsOnce(canceled(["None", "ConditionalCheckFailed"]))
        .rejectsOnce(canceled(["ConditionalCheckFailed", "ConditionalCheckFailed"]));
      ddb
        .on(GetCommand)
        .resolvesOnce({ Item: quizItem("open") })
        .resolvesOnce({ Item: quizItem("closed") })
        .resolvesOnce({});

      expect((await repo.openQuiz("Q1", "2026-01-01T00:01:00.000Z")).status).toBe("open");
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Put).toMatchObject({
        Item: { PK: "QUIZ_STATE", SK: "OPEN", quizId: "Q1" },
        ConditionExpression: "attribute_not_exists(PK)",
      });
      expect(items[1]!.Update).toMatchObject({
        Key: { PK: "QUIZ#Q1", SK: "META" },
        ConditionExpression: "#status = :draft",
      });

      await expect(repo.openQuiz("Q1", "x")).rejects.toBeInstanceOf(QuizAlreadyOpenError);
      await expect(repo.openQuiz("Q1", "x")).rejects.toBeInstanceOf(InvalidStateError);
      await expect(repo.openQuiz("Q1", "x")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("締め切りは、その問題が出題中のときだけ印を消して状態を変える", async () => {
      ddb
        .on(TransactWriteCommand)
        .resolvesOnce({})
        .rejectsOnce(canceled(["ConditionalCheckFailed", "None"]));
      ddb
        .on(GetCommand)
        .resolvesOnce({ Item: quizItem("closed") })
        .resolvesOnce({ Item: quizItem("draft") });
      expect((await repo.closeQuiz("Q1", "2026-01-01T00:02:00.000Z")).status).toBe("closed");
      const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items[0]!.Delete).toMatchObject({
        Key: { PK: "QUIZ_STATE", SK: "OPEN" },
        ConditionExpression: "quizId = :quizId",
        ExpressionAttributeValues: { ":quizId": "Q1" },
      });
      await expect(repo.closeQuiz("Q1", "x")).rejects.toBeInstanceOf(InvalidStateError);
    });

    it("回答はユーザの下に保存する（クイズを含むトランザクションにはしない）", async () => {
      ddb.on(PutCommand).resolves({});
      await repo.putQuizAnswer({ quizId: "Q1", userId: "u1", choiceId: "A", answeredAt: "2026-01-01T00:01:30.000Z" });
      expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({
        PK: "USER#u1",
        SK: "ANSWER#Q1",
        GSI1PK: "ANSWERS#Q1",
        choiceId: "A",
      });
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("削除は出題中でなければクイズを消し、その回答もまとめて消す", async () => {
      ddb.on(DeleteCommand).resolves({});
      ddb.on(QueryCommand).resolves({
        Items: [
          { quizId: "Q1", userId: "u1", choiceId: "A", answeredAt: "x" },
          { quizId: "Q1", userId: "u2", choiceId: "B", answeredAt: "x" },
        ],
      });
      ddb.on(BatchWriteCommand).resolves({});
      await repo.deleteQuiz("Q1");
      expect(ddb.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({
        Key: { PK: "QUIZ#Q1", SK: "META" },
        ConditionExpression: "attribute_exists(PK) AND #status <> :open",
      });
      expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
        IndexName: "GSI1",
        ExpressionAttributeValues: { ":pk": "ANSWERS#Q1" },
      });
      const deletes = ddb.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems!.table!;
      expect(deletes.map((d) => d.DeleteRequest!.Key)).toEqual([
        { PK: "USER#u1", SK: "ANSWER#Q1" },
        { PK: "USER#u2", SK: "ANSWER#Q1" },
      ]);
    });

    it("選択肢の増減を伴う更新は、下書きのときだけ", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: quizItem("draft") });
      await repo.updateQuiz("Q1", { text: "問題", choices: quiz.choices }, "x", true);
      await repo.updateQuiz("Q1", { text: "問題", choices: quiz.choices }, "x", false);
      const [draftOnly, any] = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.ConditionExpression);
      expect(draftOnly).toBe("attribute_exists(PK) AND #status = :draft");
      expect(any).toBe("attribute_exists(PK)");
    });
  });

  describe("設定", () => {
    it("保存されていない項目は既定値で補う", async () => {
      ddb.on(GetCommand).resolves({ Item: { PK: "SETTINGS", SK: "GLOBAL", moderation: "post" } });
      expect(await repo.getSettings()).toEqual({ ...DEFAULT_SETTINGS, moderation: "post" });
    });
  });
});

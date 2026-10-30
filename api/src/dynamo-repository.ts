import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { type PhotoStatus, type Settings, TIE_BREAK_KEYS, type TieBreakKey } from "@partally/shared";
import {
  DEFAULT_SETTINGS,
  EpithetTakenError,
  FavoriteLimitError,
  formatLabel,
  InvalidStateError,
  NotFoundError,
  type Page,
  type PhotoRecord,
  type PhotoRecordStatus,
  type PrizeRecord,
  QuizAlreadyOpenError,
  type QuizAnswerRecord,
  type QuizRecord,
  type Repository,
  TokenNotAvailableError,
  type TokenRecord,
  type UserChanges,
  type UserRecord,
} from "./repository.js";

// キー設計は docs/design.md「3. データモデル」を参照
export const keys = {
  token: (token: string) => ({ PK: `TOKEN#${token}`, SK: "META" }),
  user: (userId: string) => ({ PK: `USER#${userId}`, SK: "PROFILE" }),
  epithet: (epithet: string) => ({ PK: `EPITHET#${epithet}`, SK: "LOCK" }),
  photo: (photoId: string) => ({ PK: `PHOTO#${photoId}`, SK: "META" }),
  favorite: (userId: string, photoId: string) => ({ PK: `USER#${userId}`, SK: `FAV#${photoId}` }),
  quiz: (quizId: string) => ({ PK: `QUIZ#${quizId}`, SK: "META" }),
  quizAnswer: (userId: string, quizId: string) => ({ PK: `USER#${userId}`, SK: `ANSWER#${quizId}` }),
  /** 出題中のクイズ。同時に 1 問だけにするため、このアイテムの有無で排他する */
  openQuiz: { PK: "QUIZ_STATE", SK: "OPEN" },
  prize: (prizeId: string) => ({ PK: `PRIZE#${prizeId}`, SK: "META" }),
  settings: { PK: "SETTINGS", SK: "GLOBAL" },
  tokenLabelCounter: { PK: "COUNTER", SK: "TOKEN_LABEL" },
};

const GSI1 = "GSI1";
const GSI2 = "GSI2";
const BATCH_WRITE_MAX = 25;
const BATCH_GET_MAX = 100;

export class DynamoRepository implements Repository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getToken(token: string) {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: keys.token(token) }));
    return Item ? toTokenRecord(Item) : undefined;
  }

  async getUser(userId: string) {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: keys.user(userId) }));
    return Item ? toUserRecord(Item) : undefined;
  }

  async getUsers(userIds: string[]) {
    const unique = [...new Set(userIds)];
    const users: UserRecord[] = [];
    for (let i = 0; i < unique.length; i += BATCH_GET_MAX) {
      let keysToGet: Record<string, unknown>[] | undefined = unique.slice(i, i + BATCH_GET_MAX).map(keys.user);
      for (let attempt = 0; keysToGet && keysToGet.length > 0; attempt++) {
        if (attempt >= 5) throw new Error("BatchGet が未処理のまま残りました");
        const res: BatchGetCommandOutput = await this.client.send(
          new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keysToGet } } }),
        );
        users.push(...(res.Responses?.[this.tableName] ?? []).map(toUserRecord));
        keysToGet = res.UnprocessedKeys?.[this.tableName]?.Keys;
        if (keysToGet?.length) await sleep(50 * 2 ** attempt);
      }
    }
    return users;
  }

  async listTokens() {
    return (await this.queryGsi1("TOKENS")).map(toTokenRecord);
  }

  async listUsers() {
    return (await this.queryGsi1("USERS")).map(toUserRecord);
  }

  async createTokens(tokens: string[], createdAt: string) {
    if (tokens.length === 0) return [];
    const last = await this.allocateLabels(tokens.length);
    const first = last - tokens.length + 1;
    const records: TokenRecord[] = tokens.map((token, i) => ({
      token,
      label: formatLabel(first + i),
      status: "unbound",
      createdAt,
    }));
    await this.batchWrite(records.map((r, i) => ({ PutRequest: { Item: tokenItem(r, first + i) } })));
    return records;
  }

  async registerUser(user: UserRecord & { token: string }) {
    try {
      // 同じ QR（や同じ二つ名）への同時登録は TransactionConflict で取り消されることがある（再実行は transactWithRetry）。
      // 再実行で先の登録が済んでいれば、トークンの条件チェックで TokenNotAvailableError（409）になる。
      // 再実行しても取り消され続けたら例外のまま（500）にする。どちらが登録できたか分からないまま
      // 「登録済み」とは返さず、利用者にもう一度読み込んでもらう
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.token(user.token),
                UpdateExpression: "SET #status = :bound, userId = :userId, boundAt = :now",
                ConditionExpression: "#status = :unbound",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":bound": "bound",
                  ":unbound": "unbound",
                  ":userId": user.userId,
                  ":now": user.createdAt,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: userItem(user),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { ...keys.epithet(user.epithet), userId: user.userId },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (e) {
      const failed = conditionFailures(e);
      if (failed?.[0]) throw new TokenNotAvailableError();
      if (failed?.[2]) throw new EpithetTakenError();
      throw e;
    }
  }

  async updateUser(userId: string, changes: UserChanges, updatedAt: string) {
    const current = await this.getUser(userId);
    if (!current) throw new NotFoundError();

    const sets = ["updatedAt = :updatedAt"];
    const values: Record<string, unknown> = { ":updatedAt": updatedAt };
    if (changes.name !== undefined) {
      sets.push("#name = :name");
      values[":name"] = changes.name;
    }
    const epithetChanged = changes.epithet !== undefined && changes.epithet !== current.epithet;
    if (epithetChanged) {
      sets.push("epithet = :epithet");
      values[":epithet"] = changes.epithet;
    }

    const userUpdate = {
      TableName: this.tableName,
      Key: keys.user(userId),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: changes.name !== undefined ? { "#name": "name" } : undefined,
      ExpressionAttributeValues: values,
    };

    if (!epithetChanged) {
      try {
        const { Attributes } = await this.client.send(new UpdateCommand({ ...userUpdate, ReturnValues: "ALL_NEW" }));
        return toUserRecord(Attributes!);
      } catch (e) {
        if (isConditionalCheckFailed(e)) throw new NotFoundError();
        throw e;
      }
    }

    try {
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ...userUpdate,
                ConditionExpression: "attribute_exists(PK) AND epithet = :oldEpithet",
                ExpressionAttributeValues: { ...values, ":oldEpithet": current.epithet },
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: keys.epithet(current.epithet),
                ConditionExpression: "userId = :userId",
                ExpressionAttributeValues: { ":userId": userId },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { ...keys.epithet(changes.epithet!), userId },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (e) {
      const failed = conditionFailures(e);
      if (failed?.[2]) throw new EpithetTakenError();
      if (failed?.[0] || failed?.[1]) throw new NotFoundError();
      throw e;
    }
    return { ...current, ...definedOnly(changes), updatedAt };
  }

  async unbindUser(userId: string, updatedAt: string) {
    const current = await this.getUser(userId);
    if (current?.status !== "active" || !current.token) throw new NotFoundError();

    try {
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.user(userId),
                UpdateExpression: "SET #status = :unbound, updatedAt = :now REMOVE #token",
                ConditionExpression: "#status = :active AND #token = :token",
                ExpressionAttributeNames: { "#status": "status", "#token": "token" },
                ExpressionAttributeValues: {
                  ":unbound": "unbound",
                  ":active": "active",
                  ":token": current.token,
                  ":now": updatedAt,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.token(current.token),
                UpdateExpression: "SET #status = :unbound REMOVE userId, boundAt",
                ConditionExpression: "userId = :userId",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":unbound": "unbound", ":userId": userId },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (conditionFailures(e)) throw new NotFoundError();
      throw e;
    }
    const { token: _removed, ...rest } = current;
    return { ...rest, status: "unbound" as const, updatedAt };
  }

  async getPhoto(photoId: string) {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: keys.photo(photoId) }));
    return Item ? toPhotoRecord(Item) : undefined;
  }

  async listPhotosByStatus(status: PhotoStatus, limit: number, cursor?: string): Promise<Page<PhotoRecord>> {
    const page = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `PHOTOS#${status}` },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: decodeCursor(cursor),
      }),
    );
    return { items: (page.Items ?? []).map(toPhotoRecord), cursor: encodeCursor(page.LastEvaluatedKey) };
  }

  async listPhotosByUploader(uploaderId: string) {
    const items = await this.queryAll({
      IndexName: GSI2,
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": `USER#${uploaderId}` },
      ScanIndexForward: false,
    });
    return items.map(toPhotoRecord);
  }

  async createPhoto(photo: PhotoRecord) {
    const approved = photo.status === "approved";
    try {
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: photoItem(photo),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.user(photo.uploaderId),
                UpdateExpression: approved ? "ADD uploadCount :one, approvedCount :one" : "ADD uploadCount :one",
                ConditionExpression: "attribute_exists(PK)",
                ExpressionAttributeValues: { ":one": 1 },
              },
            },
          ],
        }),
      );
      return true;
    } catch (e) {
      const failed = conditionFailures(e);
      if (failed?.[0]) return false;
      if (failed?.[1]) throw new NotFoundError();
      throw e;
    }
  }

  async approvePhoto(photoId: string, reviewedAt: string) {
    return this.transition(photoId, "pending", "approved", reviewedAt, { approvedCount: 1 });
  }

  async rejectPhoto(photoId: string, reviewedAt: string) {
    return this.transition(photoId, "pending", "rejected", reviewedAt, { uploadCount: -1 });
  }

  async deleteApprovedPhoto(photoId: string, deletedAt: string) {
    return this.transition(photoId, "approved", "deleted", deletedAt, { uploadCount: -1, approvedCount: -1 });
  }

  async addFavorite(userId: string, photo: PhotoRecord, limit: number, createdAt: string) {
    // 自分の写真は選べない（同じユーザのアイテムを 1 トランザクションで 2 回更新することにもなる）
    if (userId === photo.uploaderId) throw new InvalidStateError();
    // 選択数の属性が無い（機能追加前に登録した）ユーザは条件式で上限 0 を判定できないため、先に弾く
    if (limit <= 0) throw new FavoriteLimitError();
    try {
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...keys.favorite(userId, photo.photoId),
                  GSI1PK: `FAVS#${photo.photoId}`,
                  GSI1SK: `${createdAt}#${userId}`,
                  userId,
                  photoId: photo.photoId,
                  createdAt,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.user(userId),
                UpdateExpression: "ADD favoritesGiven :one",
                ConditionExpression:
                  "attribute_exists(PK) AND (attribute_not_exists(favoritesGiven) OR favoritesGiven < :limit)",
                ExpressionAttributeValues: { ":one": 1, ":limit": limit },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.photo(photo.photoId),
                UpdateExpression: "ADD favoriteCount :one",
                ConditionExpression: "#status = :approved",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":one": 1, ":approved": "approved" },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.user(photo.uploaderId),
                UpdateExpression: "ADD favoritesReceived :one",
                ConditionExpression: "attribute_exists(PK)",
                ExpressionAttributeValues: { ":one": 1 },
              },
            },
          ],
        }),
      );
    } catch (e) {
      const failed = conditionFailures(e);
      if (failed?.[0]) return; // 既に選んでいる
      if (failed?.[1]) throw new FavoriteLimitError();
      if (failed?.[2] || failed?.[3]) throw new InvalidStateError();
      throw e;
    }
  }

  async removeFavorite(userId: string, photo: PhotoRecord) {
    try {
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.tableName,
                Key: keys.favorite(userId, photo.photoId),
                ConditionExpression: "attribute_exists(PK)",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.user(userId),
                UpdateExpression: "ADD favoritesGiven :minus",
                ExpressionAttributeValues: { ":minus": -1 },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.photo(photo.photoId),
                UpdateExpression: "ADD favoriteCount :minus",
                ExpressionAttributeValues: { ":minus": -1 },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.user(photo.uploaderId),
                UpdateExpression: "ADD favoritesReceived :minus",
                ExpressionAttributeValues: { ":minus": -1 },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (conditionFailures(e)?.[0]) return; // 選んでいない
      throw e;
    }
  }

  async listFavoritePhotoIds(userId: string) {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :fav)",
      ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":fav": "FAV#" },
    });
    return items.map((item) => item.photoId as string);
  }

  async listFavoritesOfPhoto(photoId: string) {
    const items = await this.queryAll({
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `FAVS#${photoId}` },
    });
    return items.map((item) => ({
      userId: item.userId as string,
      photoId: item.photoId as string,
      createdAt: item.createdAt as string,
    }));
  }

  async clearFavorites(photoId: string) {
    // GSI は結果整合のため、直前に付いたお気に入りが一覧に出ないことがある。
    // 写真の favoriteCount（強い整合性で読む）が 0 になるまで、少し待って取り直す
    for (let attempt = 0; attempt < 5; attempt++) {
      const { Item } = await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: keys.photo(photoId), ConsistentRead: true }),
      );
      if (!Item) return;
      const photo = toPhotoRecord(Item);
      if (photo.favoriteCount <= 0) return;
      if (attempt > 0) await sleep(200 * attempt);
      for (const { userId } of await this.listFavoritesOfPhoto(photoId)) await this.removeFavorite(userId, photo);
    }
    console.warn(`お気に入りを外しきれませんでした: ${photoId}`);
  }

  async createQuiz(quiz: QuizRecord) {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: quizItem(quiz),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async getQuiz(quizId: string) {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: keys.quiz(quizId), ConsistentRead: true }),
    );
    return Item ? toQuizRecord(Item) : undefined;
  }

  async listQuizzes() {
    return (await this.queryGsi1("QUIZZES")).map(toQuizRecord);
  }

  async updateQuiz(
    quizId: string,
    changes: Pick<QuizRecord, "text" | "choices">,
    updatedAt: string,
    onlyIfDraft: boolean,
  ) {
    try {
      const { Attributes } = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.quiz(quizId),
          UpdateExpression: "SET #text = :text, choices = :choices, updatedAt = :updatedAt",
          ConditionExpression: onlyIfDraft ? "attribute_exists(PK) AND #status = :draft" : "attribute_exists(PK)",
          ExpressionAttributeNames: { "#text": "text", ...(onlyIfDraft ? { "#status": "status" } : {}) },
          ExpressionAttributeValues: {
            ":text": changes.text,
            ":choices": changes.choices,
            ":updatedAt": updatedAt,
            ...(onlyIfDraft ? { ":draft": "draft" } : {}),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return toQuizRecord(Attributes!);
    } catch (e) {
      if (isConditionalCheckFailed(e)) throw await this.quizStateError(quizId);
      throw e;
    }
  }

  async deleteQuiz(quizId: string) {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: keys.quiz(quizId),
          ConditionExpression: "attribute_exists(PK) AND #status <> :open",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":open": "open" },
        }),
      );
    } catch (e) {
      if (isConditionalCheckFailed(e)) throw await this.quizStateError(quizId);
      throw e;
    }
    // クイズを先に消すので、途中で失敗して回答が残っても点数には数えられない
    const answers = await this.listQuizAnswersByQuiz(quizId);
    await this.batchWrite(answers.map((a) => ({ DeleteRequest: { Key: keys.quizAnswer(a.userId, a.quizId) } })));
  }

  async openQuiz(quizId: string, openedAt: string) {
    try {
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...keys.openQuiz, quizId },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.quiz(quizId),
                UpdateExpression: "SET #status = :open, openedAt = :at, updatedAt = :at",
                ConditionExpression: "#status = :draft",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":open": "open", ":draft": "draft", ":at": openedAt },
              },
            },
          ],
        }),
      );
    } catch (e) {
      // 無い・下書きでないを、別の問題が出題中より先に判定する（メモリ実装と同じ順）
      const failed = conditionFailures(e);
      if (failed?.[1]) throw await this.quizStateError(quizId);
      if (failed?.[0]) throw new QuizAlreadyOpenError();
      throw e;
    }
    return (await this.getQuiz(quizId))!;
  }

  async closeQuiz(quizId: string, closedAt: string) {
    try {
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.tableName,
                Key: keys.openQuiz,
                ConditionExpression: "quizId = :quizId",
                ExpressionAttributeValues: { ":quizId": quizId },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.quiz(quizId),
                UpdateExpression: "SET #status = :closed, closedAt = :at, updatedAt = :at",
                ConditionExpression: "#status = :open",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":closed": "closed", ":open": "open", ":at": closedAt },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (conditionFailures(e)) throw await this.quizStateError(quizId);
      throw e;
    }
    return (await this.getQuiz(quizId))!;
  }

  async getOpenQuizId() {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: keys.openQuiz, ConsistentRead: true }),
    );
    return Item?.quizId as string | undefined;
  }

  async putQuizAnswer(answer: QuizAnswerRecord) {
    // 全員が一斉に答えるので、クイズのアイテムを含むトランザクションにはしない（TransactionConflict が多発する）。
    // 呼び出し側の確認と保存の間に締め切られた回答は、点数の計算で answeredAt > closedAt として除く
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...keys.quizAnswer(answer.userId, answer.quizId),
          GSI1PK: `ANSWERS#${answer.quizId}`,
          GSI1SK: answer.userId,
          ...answer,
        },
      }),
    );
  }

  async getQuizAnswer(userId: string, quizId: string) {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: keys.quizAnswer(userId, quizId) }),
    );
    return Item ? toQuizAnswerRecord(Item) : undefined;
  }

  async listQuizAnswersByUser(userId: string) {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :answer)",
      ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":answer": "ANSWER#" },
    });
    return items.map(toQuizAnswerRecord);
  }

  async listQuizAnswersByQuiz(quizId: string) {
    return (await this.queryGsi1(`ANSWERS#${quizId}`)).map(toQuizAnswerRecord);
  }

  /** 条件付き更新に失敗したクイズが、無いのか状態が合わないのかを調べる */
  private async quizStateError(quizId: string) {
    return (await this.getQuiz(quizId)) ? new InvalidStateError() : new NotFoundError();
  }

  /** 25 件ずつに分けて書き込み、未処理分は数回まで再送する */
  private async batchWrite(writes: NonNullable<BatchWriteCommandInput["RequestItems"]>[string]) {
    for (let i = 0; i < writes.length; i += BATCH_WRITE_MAX) {
      let requests: typeof writes | undefined = writes.slice(i, i + BATCH_WRITE_MAX);
      for (let attempt = 0; requests && requests.length > 0; attempt++) {
        if (attempt >= 5) throw new Error("BatchWrite が未処理のまま残りました");
        const { UnprocessedItems }: BatchWriteCommandOutput = await this.client.send(
          new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }),
        );
        requests = UnprocessedItems?.[this.tableName];
        if (requests?.length) await sleep(50 * 2 ** attempt);
      }
    }
  }

  /**
   * トランザクションはすべてこれで送る。同じアイテムを同時に書き換えるトランザクションは TransactionConflict で
   * 取り消されることがあるため、少し待って再実行する（人気の写真へのお気に入り、同じ QR への同時登録、
   * 同じユーザのカウンタの更新など）。取り消されたトランザクションは何も書き込んでいないので、再実行しても二重にならない。
   * 応答が失われたときの SDK 自身の再送は、SDK が自動で付ける ClientRequestToken で重複しない
   */
  private async transactWithRetry(command: TransactWriteCommand) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.send(command);
      } catch (e) {
        if (attempt >= 4 || !isTransactionConflict(e)) throw e;
        await sleep(20 * 2 ** attempt + Math.random() * 20);
      }
    }
  }

  async createPrize(prize: PrizeRecord) {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: prizeItem(prize),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async getPrize(prizeId: string) {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: keys.prize(prizeId), ConsistentRead: true }),
    );
    return Item ? toPrizeRecord(Item) : undefined;
  }

  async listPrizes() {
    return (await this.queryGsi1("PRIZES")).map(toPrizeRecord);
  }

  async updatePrize(
    prizeId: string,
    changes: Pick<PrizeRecord, "name" | "quantity" | "positions" | "imageId">,
    updatedAt: string,
  ) {
    const set = ["#name = :name", "quantity = :quantity", "positions = :positions", "updatedAt = :updatedAt"];
    const values: Record<string, unknown> = {
      ":name": changes.name,
      ":quantity": changes.quantity,
      ":positions": changes.positions,
      ":updatedAt": updatedAt,
    };
    if (changes.imageId !== undefined) {
      set.push("imageId = :imageId");
      values[":imageId"] = changes.imageId;
    }
    try {
      const { Attributes } = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.prize(prizeId),
          UpdateExpression: `SET ${set.join(", ")}${changes.imageId === undefined ? " REMOVE imageId" : ""}`,
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return toPrizeRecord(Attributes!);
    } catch (e) {
      if (isConditionalCheckFailed(e)) throw new NotFoundError();
      throw e;
    }
  }

  async deletePrize(prizeId: string) {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: keys.prize(prizeId),
          ConditionExpression: "attribute_exists(PK)",
        }),
      );
    } catch (e) {
      if (isConditionalCheckFailed(e)) throw new NotFoundError();
      throw e;
    }
  }

  async getSettings(): Promise<Settings> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: keys.settings }));
    const stored = Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS)
        .filter((key) => Item?.[key] !== undefined)
        .map((key) => [key, Item![key]]),
    );
    // クイズの点数は以前 showPoints で一緒に伏せていた。別の設定にする前に伏せていたなら、伏せたままにする
    if (stored.showQuizPoints === undefined && stored.showPoints !== undefined)
      stored.showQuizPoints = stored.showPoints;
    // 優先順は、知らない項目を除き、足りない項目を既定の順で後ろに補う（項目を足しても保存済みの設定で保存できなくならないように）
    if (Array.isArray(stored.tieBreakOrder)) {
      const known = (stored.tieBreakOrder as unknown[]).filter((k): k is TieBreakKey =>
        (TIE_BREAK_KEYS as readonly unknown[]).includes(k),
      );
      const unique = [...new Set(known)];
      stored.tieBreakOrder = [...unique, ...TIE_BREAK_KEYS.filter((k) => !unique.includes(k))];
    }
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  async putSettings(settings: Settings) {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { ...keys.settings, ...settings } }));
  }

  /** 写真の状態を from → to に変え、同じトランザクションでアップロード者のカウンタを更新する */
  private async transition(
    photoId: string,
    from: PhotoRecordStatus,
    to: PhotoRecordStatus,
    reviewedAt: string,
    counters: Partial<Record<"uploadCount" | "approvedCount", number>>,
  ): Promise<PhotoRecord> {
    const photo = await this.getPhoto(photoId);
    if (!photo) throw new NotFoundError();
    if (photo.status !== from) throw new InvalidStateError();
    const entries = Object.entries(counters);
    try {
      await this.transactWithRetry(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.photo(photoId),
                UpdateExpression: "SET #status = :to, GSI1PK = :gsi1pk, reviewedAt = :reviewedAt",
                ConditionExpression: "#status = :from",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":to": to,
                  ":gsi1pk": `PHOTOS#${to}`,
                  ":reviewedAt": reviewedAt,
                  ":from": from,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.user(photo.uploaderId),
                UpdateExpression: `ADD ${entries.map(([attr]) => `${attr} :${attr}`).join(", ")}`,
                ExpressionAttributeValues: Object.fromEntries(entries.map(([attr, delta]) => [`:${attr}`, delta])),
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (conditionFailures(e)?.[0]) throw new InvalidStateError();
      throw e;
    }
    return { ...photo, status: to, reviewedAt };
  }

  /** 通し番号カウンタを count だけ進め、採番後の最大値を返す */
  private async allocateLabels(count: number): Promise<number> {
    const { Attributes } = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: keys.tokenLabelCounter,
        UpdateExpression: "ADD #value :n",
        ExpressionAttributeNames: { "#value": "value" },
        ExpressionAttributeValues: { ":n": count },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(Attributes?.value);
  }

  private async queryGsi1(pk: string): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    });
  }

  /** ページングをたどって条件に合うアイテムをすべて返す */
  private async queryAll(
    input: Omit<QueryCommandInput, "TableName" | "ExclusiveStartKey">,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];
    do {
      const page = await this.client.send(new QueryCommand({ ...input, TableName: this.tableName, ExclusiveStartKey }));
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
}

function tokenItem(r: TokenRecord, labelNumber: number) {
  return {
    ...keys.token(r.token),
    GSI1PK: "TOKENS",
    // 表示用 label は 3 桁だが、1000 件を超えても並ぶよう GSI のソートキーは 6 桁にする
    GSI1SK: String(labelNumber).padStart(6, "0"),
    ...r,
  };
}

function photoItem(photo: PhotoRecord) {
  const sortKey = `${photo.createdAt}#${photo.photoId}`;
  return {
    ...keys.photo(photo.photoId),
    GSI1PK: `PHOTOS#${photo.status}`,
    GSI1SK: sortKey,
    GSI2PK: `USER#${photo.uploaderId}`,
    GSI2SK: sortKey,
    ...photo,
  };
}

function toPhotoRecord(item: Record<string, unknown>): PhotoRecord {
  return {
    photoId: item.photoId as string,
    uploaderId: item.uploaderId as string,
    status: item.status as PhotoRecordStatus,
    favoriteCount: Number(item.favoriteCount ?? 0),
    createdAt: item.createdAt as string,
    reviewedAt: item.reviewedAt as string | undefined,
  };
}

function quizItem(quiz: QuizRecord) {
  return { ...keys.quiz(quiz.quizId), GSI1PK: "QUIZZES", GSI1SK: `${quiz.createdAt}#${quiz.quizId}`, ...quiz };
}

function toQuizRecord(item: Record<string, unknown>): QuizRecord {
  return {
    quizId: item.quizId as string,
    text: item.text as string,
    choices: ((item.choices ?? []) as Record<string, unknown>[]).map((c) => ({
      choiceId: c.choiceId as string,
      text: c.text as string,
      points: Number(c.points ?? 0),
    })),
    status: item.status as QuizRecord["status"],
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
    openedAt: item.openedAt as string | undefined,
    closedAt: item.closedAt as string | undefined,
  };
}

function prizeItem(prize: PrizeRecord) {
  return { ...keys.prize(prize.prizeId), GSI1PK: "PRIZES", GSI1SK: `${prize.createdAt}#${prize.prizeId}`, ...prize };
}

function toPrizeRecord(item: Record<string, unknown>): PrizeRecord {
  return {
    prizeId: item.prizeId as string,
    name: item.name as string,
    quantity: Number(item.quantity ?? 0),
    positions: ((item.positions ?? []) as unknown[]).map(Number),
    imageId: item.imageId as string | undefined,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function toQuizAnswerRecord(item: Record<string, unknown>): QuizAnswerRecord {
  return {
    quizId: item.quizId as string,
    userId: item.userId as string,
    choiceId: item.choiceId as string,
    answeredAt: item.answeredAt as string,
  };
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function userItem(user: UserRecord) {
  return { ...keys.user(user.userId), GSI1PK: "USERS", GSI1SK: user.createdAt, ...user };
}

function toTokenRecord(item: Record<string, unknown>): TokenRecord {
  return {
    token: item.token as string,
    label: item.label as string,
    status: item.status as TokenRecord["status"],
    userId: item.userId as string | undefined,
    createdAt: item.createdAt as string,
    boundAt: item.boundAt as string | undefined,
  };
}

function toUserRecord(item: Record<string, unknown>): UserRecord {
  return {
    userId: item.userId as string,
    name: item.name as string,
    epithet: item.epithet as string,
    token: item.token as string | undefined,
    status: item.status as UserRecord["status"],
    uploadCount: Number(item.uploadCount ?? 0),
    approvedCount: Number(item.approvedCount ?? 0),
    favoritesGiven: Number(item.favoritesGiven ?? 0),
    favoritesReceived: Number(item.favoritesReceived ?? 0),
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

/** 他のトランザクションと同じアイテムを同時に更新して取り消されたか */
function isTransactionConflict(e: unknown): boolean {
  return (
    e instanceof TransactionCanceledException &&
    (e.CancellationReasons ?? []).some((r) => r.Code === "TransactionConflict") &&
    !conditionFailures(e)
  );
}

/**
 * トランザクションが条件チェックで失敗した場合、各アイテムが失敗したかどうかの配列を返す。
 * それ以外のエラーなら undefined。
 */
function conditionFailures(e: unknown): boolean[] | undefined {
  if (!(e instanceof TransactionCanceledException)) return undefined;
  const reasons = e.CancellationReasons ?? [];
  if (!reasons.some((r) => r.Code === "ConditionalCheckFailed")) return undefined;
  return reasons.map((r) => r.Code === "ConditionalCheckFailed");
}

function isConditionalCheckFailed(e: unknown): boolean {
  return e instanceof Error && e.name === "ConditionalCheckFailedException";
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

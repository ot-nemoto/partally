import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { PhotoStatus, Settings } from "@partally/shared";
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
    const puts = records.map((r, i) => ({ PutRequest: { Item: tokenItem(r, first + i) } }));

    for (let i = 0; i < puts.length; i += BATCH_WRITE_MAX) {
      let requests: NonNullable<BatchWriteCommandInput["RequestItems"]>[string] | undefined = puts.slice(
        i,
        i + BATCH_WRITE_MAX,
      );
      // 未処理分は最大数回まで再送する
      for (let attempt = 0; requests && requests.length > 0; attempt++) {
        if (attempt >= 5) throw new Error("BatchWrite が未処理のまま残りました");
        const { UnprocessedItems }: BatchWriteCommandOutput = await this.client.send(
          new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }),
        );
        requests = UnprocessedItems?.[this.tableName];
        if (requests?.length) await sleep(50 * 2 ** attempt);
      }
    }
    return records;
  }

  async registerUser(user: UserRecord & { token: string }) {
    try {
      await this.client.send(
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
      await this.client.send(
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
      await this.client.send(
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
      await this.client.send(
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
    try {
      await this.client.send(
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
      if (failed?.[2]) throw new InvalidStateError();
      throw e;
    }
  }

  async removeFavorite(userId: string, photo: PhotoRecord) {
    try {
      await this.client.send(
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

  async listFavoriteUserIds(photoId: string) {
    const items = await this.queryAll({
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `FAVS#${photoId}` },
    });
    return items.map((item) => item.userId as string);
  }

  async getSettings(): Promise<Settings> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: keys.settings }));
    const stored = Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS)
        .filter((key) => Item?.[key] !== undefined)
        .map((key) => [key, Item![key]]),
    );
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
      await this.client.send(
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

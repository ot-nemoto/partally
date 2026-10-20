import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EpithetTakenError,
  formatLabel,
  NotFoundError,
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
  tokenLabelCounter: { PK: "COUNTER", SK: "TOKEN_LABEL" },
};

const GSI1 = "GSI1";
const BATCH_WRITE_MAX = 25;

export class DynamoRepository implements Repository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getToken(token: string) {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: keys.token(token) }),
    );
    return Item ? toTokenRecord(Item) : undefined;
  }

  async getUser(userId: string) {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: keys.user(userId) }),
    );
    return Item ? toUserRecord(Item) : undefined;
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
        const { Attributes } = await this.client.send(
          new UpdateCommand({ ...userUpdate, ReturnValues: "ALL_NEW" }),
        );
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
    if (!current || current.status !== "active" || !current.token) throw new NotFoundError();

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
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ExclusiveStartKey,
        }),
      );
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

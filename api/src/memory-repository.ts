import type { GameStatus, PhotoStatus, Settings } from "@partally/shared";
import {
  DEFAULT_SETTINGS,
  EpithetTakenError,
  FavoriteLimitError,
  formatLabel,
  GameAlreadyOpenError,
  type GameAnswerRecord,
  type GameRecord,
  InvalidStateError,
  NotFoundError,
  type Page,
  type PhotoRecord,
  type PrizeRecord,
  type Repository,
  type ScheduleItemRecord,
  TokenNotAvailableError,
  type TokenRecord,
  type UserChanges,
  type UserRecord,
} from "./repository.js";

/** ローカル開発・テスト用。DynamoDB 実装と同じ条件チェックを再現する */
export class MemoryRepository implements Repository {
  private tokens = new Map<string, TokenRecord>();
  private users = new Map<string, UserRecord>();
  private epithets = new Map<string, string>();
  private photos = new Map<string, PhotoRecord>();
  /** 「選んだ人 → 写真」の組と選んだ時刻。キーは `${userId}#${photoId}` */
  private favorites = new Map<string, string>();
  private prizes = new Map<string, PrizeRecord>();
  private scheduleItems = new Map<string, ScheduleItemRecord>();
  private games = new Map<string, GameRecord>();
  private openGameId: string | undefined;
  /** キーは `${userId}#${gameId}` */
  private gameAnswers = new Map<string, GameAnswerRecord>();
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private labelCounter = 0;

  async getToken(token: string) {
    return clone(this.tokens.get(token));
  }

  async getUser(userId: string) {
    return clone(this.users.get(userId));
  }

  async listTokens() {
    return [...this.tokens.values()].sort((a, b) => a.label.localeCompare(b.label)).map(clone);
  }

  async listUsers() {
    return [...this.users.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  async createTokens(tokens: string[], createdAt: string) {
    return tokens.map((token) => {
      const record: TokenRecord = {
        token,
        label: formatLabel(++this.labelCounter),
        status: "unbound",
        createdAt,
      };
      this.tokens.set(token, record);
      return clone(record);
    });
  }

  async registerUser(user: UserRecord & { token: string }) {
    const token = this.tokens.get(user.token);
    if (token?.status !== "unbound") throw new TokenNotAvailableError();
    if (this.epithets.has(user.epithet)) throw new EpithetTakenError();

    this.tokens.set(user.token, {
      ...token,
      status: "bound",
      userId: user.userId,
      boundAt: user.createdAt,
    });
    this.users.set(user.userId, { ...user });
    this.epithets.set(user.epithet, user.userId);
  }

  async updateUser(userId: string, changes: UserChanges, updatedAt: string) {
    const user = this.users.get(userId);
    if (!user) throw new NotFoundError();

    if (changes.epithet !== undefined && changes.epithet !== user.epithet) {
      if (this.epithets.has(changes.epithet)) throw new EpithetTakenError();
      this.epithets.delete(user.epithet);
      this.epithets.set(changes.epithet, userId);
    }
    const updated = { ...user, ...definedOnly(changes), updatedAt };
    this.users.set(userId, updated);
    return clone(updated);
  }

  async unbindUser(userId: string, updatedAt: string) {
    const user = this.users.get(userId);
    if (user?.status !== "active" || !user.token) throw new NotFoundError();
    const token = this.tokens.get(user.token);
    if (!token || token.userId !== userId) throw new NotFoundError();

    this.tokens.set(token.token, {
      token: token.token,
      label: token.label,
      status: "unbound",
      createdAt: token.createdAt,
    });
    const { token: _removed, ...rest } = user;
    const updated: UserRecord = { ...rest, status: "unbound", updatedAt };
    this.users.set(userId, updated);
    return clone(updated);
  }

  async getUsers(userIds: string[]) {
    return [...new Set(userIds)].flatMap((id) => {
      const user = this.users.get(id);
      return user ? [clone(user)] : [];
    });
  }

  async getPhoto(photoId: string) {
    return clone(this.photos.get(photoId));
  }

  async listPhotosByStatus(status: PhotoStatus, limit: number, cursor?: string): Promise<Page<PhotoRecord>> {
    const all = this.sortedPhotos().filter((p) => p.status === status);
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit);
    const next = start + limit;
    return { items: items.map(clone), cursor: next < all.length ? String(next) : undefined };
  }

  async listPhotosByUploader(uploaderId: string) {
    return this.sortedPhotos()
      .filter((p) => p.uploaderId === uploaderId)
      .map(clone);
  }

  async createPhoto(photo: PhotoRecord) {
    if (this.photos.has(photo.photoId)) return false;
    const user = this.users.get(photo.uploaderId);
    if (!user) throw new NotFoundError();
    this.photos.set(photo.photoId, { ...photo });
    user.uploadCount++;
    if (photo.status === "approved") user.approvedCount++;
    return true;
  }

  async approvePhoto(photoId: string, reviewedAt: string) {
    const photo = this.pendingPhoto(photoId);
    photo.status = "approved";
    photo.reviewedAt = reviewedAt;
    this.userOf(photo).approvedCount++;
    return clone(photo);
  }

  async rejectPhoto(photoId: string, reviewedAt: string) {
    const photo = this.pendingPhoto(photoId);
    photo.status = "rejected";
    photo.reviewedAt = reviewedAt;
    this.userOf(photo).uploadCount--;
    return clone(photo);
  }

  async deleteApprovedPhoto(photoId: string, deletedAt: string) {
    const photo = this.photos.get(photoId);
    if (!photo) throw new NotFoundError();
    if (photo.status !== "approved") throw new InvalidStateError();
    photo.status = "deleted";
    photo.reviewedAt = deletedAt;
    const user = this.userOf(photo);
    user.uploadCount--;
    user.approvedCount--;
    return clone(photo);
  }

  async addFavorite(userId: string, photo: PhotoRecord, limit: number, createdAt: string) {
    const key = `${userId}#${photo.photoId}`;
    if (this.favorites.has(key)) return;
    const chooser = this.users.get(userId);
    if (!chooser) throw new NotFoundError();
    if (chooser.favoritesGiven >= limit) throw new FavoriteLimitError();
    const stored = this.photos.get(photo.photoId);
    if (stored?.status !== "approved") throw new InvalidStateError();
    this.favorites.set(key, createdAt);
    chooser.favoritesGiven++;
    stored.favoriteCount++;
    this.userOf(stored).favoritesReceived++;
  }

  async removeFavorite(userId: string, photo: PhotoRecord) {
    const key = `${userId}#${photo.photoId}`;
    if (!this.favorites.delete(key)) return;
    const chooser = this.users.get(userId);
    if (chooser) chooser.favoritesGiven--;
    const stored = this.photos.get(photo.photoId);
    if (stored) {
      stored.favoriteCount--;
      this.userOf(stored).favoritesReceived--;
    }
  }

  async listFavoritePhotoIds(userId: string) {
    return [...this.favorites.keys()].filter((k) => k.startsWith(`${userId}#`)).map((k) => k.split("#")[1]!);
  }

  async listFavoritesOfPhoto(photoId: string) {
    return [...this.favorites]
      .filter(([k]) => k.endsWith(`#${photoId}`))
      .map(([k, createdAt]) => ({ userId: k.split("#")[0]!, photoId, createdAt }));
  }

  async clearFavorites(photoId: string) {
    const photo = this.photos.get(photoId);
    if (!photo) return;
    for (const { userId } of await this.listFavoritesOfPhoto(photoId)) await this.removeFavorite(userId, photo);
  }

  async createPrize(prize: PrizeRecord) {
    this.prizes.set(prize.prizeId, clone(prize));
  }

  async getPrize(prizeId: string) {
    return clone(this.prizes.get(prizeId));
  }

  async listPrizes() {
    return [...this.prizes.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.prizeId.localeCompare(b.prizeId))
      .map(clone);
  }

  async updatePrize(
    prizeId: string,
    changes: Pick<PrizeRecord, "name" | "quantity" | "positions" | "imageId">,
    updatedAt: string,
  ) {
    const prize = this.prizes.get(prizeId);
    if (!prize) throw new NotFoundError();
    const updated: PrizeRecord = { ...prize, ...clone(changes), updatedAt };
    if (changes.imageId === undefined) delete updated.imageId;
    this.prizes.set(prizeId, updated);
    return clone(updated);
  }

  async deletePrize(prizeId: string) {
    if (!this.prizes.delete(prizeId)) throw new NotFoundError();
  }

  async createScheduleItem(item: ScheduleItemRecord) {
    this.scheduleItems.set(item.itemId, clone(item));
  }

  async listScheduleItems() {
    return [...this.scheduleItems.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId))
      .map(clone);
  }

  async updateScheduleItem(
    itemId: string,
    changes: Pick<ScheduleItemRecord, "title" | "detail" | "startMinute" | "durationMinutes">,
    updatedAt: string,
  ) {
    const item = this.scheduleItems.get(itemId);
    if (!item) throw new NotFoundError();
    Object.assign(item, clone(changes), { updatedAt });
    return clone(item);
  }

  async deleteScheduleItem(itemId: string) {
    if (!this.scheduleItems.delete(itemId)) throw new NotFoundError();
  }

  async createGame(game: GameRecord) {
    this.games.set(game.gameId, clone(game));
  }

  async getGame(gameId: string) {
    return clone(this.games.get(gameId));
  }

  async listGames() {
    return [...this.games.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.gameId.localeCompare(b.gameId))
      .map(clone);
  }

  async updateGame(
    gameId: string,
    changes: Pick<GameRecord, "name" | "description" | "imageId" | "slots" | "choices">,
    updatedAt: string,
    expectedUpdatedAt?: string,
  ) {
    const game = this.games.get(gameId);
    if (!game) throw new NotFoundError();
    if (expectedUpdatedAt !== undefined && game.updatedAt !== expectedUpdatedAt) throw new InvalidStateError();
    Object.assign(game, clone(changes), { updatedAt });
    return clone(game);
  }

  async changeGameStatus(gameId: string, from: GameStatus, to: GameStatus, at: string) {
    const game = this.games.get(gameId);
    if (!game) throw new NotFoundError();
    if (game.status !== from || from === to) throw new InvalidStateError();
    if (to === "open" && this.openGameId !== undefined) throw new GameAlreadyOpenError();
    if (to === "open") {
      this.openGameId = gameId;
      game.openedAt = at;
    }
    if (from === "open") this.openGameId = undefined;
    if (to === "confirmed") game.confirmedAt = at;
    if (from === "confirmed") delete game.confirmedAt;
    game.status = to;
    game.updatedAt = at;
    return clone(game);
  }

  async getOpenGameId() {
    return this.openGameId;
  }

  async deleteGame(gameId: string) {
    const game = this.games.get(gameId);
    if (!game) throw new NotFoundError();
    if (game.status === "open") throw new InvalidStateError();
    this.games.delete(gameId);
    for (const [key, answer] of this.gameAnswers) if (answer.gameId === gameId) this.gameAnswers.delete(key);
  }

  async putGameAnswer(answer: GameAnswerRecord) {
    this.gameAnswers.set(`${answer.userId}#${answer.gameId}`, clone(answer));
  }

  async getGameAnswer(userId: string, gameId: string) {
    return clone(this.gameAnswers.get(`${userId}#${gameId}`));
  }

  async listGameAnswersByUser(userId: string) {
    return [...this.gameAnswers.values()].filter((a) => a.userId === userId).map(clone);
  }

  async listGameAnswersByGame(gameId: string) {
    return [...this.gameAnswers.values()].filter((a) => a.gameId === gameId).map(clone);
  }

  async getSettings() {
    return { ...this.settings };
  }

  async putSettings(settings: Settings) {
    this.settings = { ...settings };
  }

  private sortedPhotos() {
    return [...this.photos.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.photoId.localeCompare(a.photoId),
    );
  }

  private pendingPhoto(photoId: string) {
    const photo = this.photos.get(photoId);
    if (!photo) throw new NotFoundError();
    if (photo.status !== "pending") throw new InvalidStateError();
    return photo;
  }

  private userOf(photo: PhotoRecord) {
    const user = this.users.get(photo.uploaderId);
    if (!user) throw new NotFoundError();
    return user;
  }
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

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
  QuizAlreadyOpenError,
  type QuizAnswerRecord,
  type QuizRecord,
  type Repository,
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
  /** 「選んだ人 → 写真」の組。キーは `${userId}#${photoId}` */
  private favorites = new Set<string>();
  private quizzes = new Map<string, QuizRecord>();
  /** キーは `${userId}#${quizId}` */
  private quizAnswers = new Map<string, QuizAnswerRecord>();
  private openQuizId: string | undefined;
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

  async addFavorite(userId: string, photo: PhotoRecord, limit: number) {
    const key = `${userId}#${photo.photoId}`;
    if (this.favorites.has(key)) return;
    const chooser = this.users.get(userId);
    if (!chooser) throw new NotFoundError();
    if (chooser.favoritesGiven >= limit) throw new FavoriteLimitError();
    const stored = this.photos.get(photo.photoId);
    if (stored?.status !== "approved") throw new InvalidStateError();
    this.favorites.add(key);
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
    return [...this.favorites].filter((k) => k.startsWith(`${userId}#`)).map((k) => k.split("#")[1]!);
  }

  async listFavoriteUserIds(photoId: string) {
    return [...this.favorites].filter((k) => k.endsWith(`#${photoId}`)).map((k) => k.split("#")[0]!);
  }

  async clearFavorites(photoId: string) {
    const photo = this.photos.get(photoId);
    if (!photo) return;
    for (const userId of await this.listFavoriteUserIds(photoId)) await this.removeFavorite(userId, photo);
  }

  async createQuiz(quiz: QuizRecord) {
    this.quizzes.set(quiz.quizId, clone(quiz));
  }

  async getQuiz(quizId: string) {
    return clone(this.quizzes.get(quizId));
  }

  async listQuizzes() {
    return [...this.quizzes.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.quizId.localeCompare(b.quizId))
      .map(clone);
  }

  async updateQuiz(
    quizId: string,
    changes: Pick<QuizRecord, "text" | "choices">,
    updatedAt: string,
    onlyIfDraft: boolean,
  ) {
    const quiz = this.quizzes.get(quizId);
    if (!quiz) throw new NotFoundError();
    if (onlyIfDraft && quiz.status !== "draft") throw new InvalidStateError();
    Object.assign(quiz, clone(changes), { updatedAt });
    return clone(quiz);
  }

  async deleteQuiz(quizId: string) {
    const quiz = this.quizzes.get(quizId);
    if (!quiz) throw new NotFoundError();
    if (quiz.status === "open") throw new InvalidStateError();
    this.quizzes.delete(quizId);
    for (const [key, answer] of this.quizAnswers) if (answer.quizId === quizId) this.quizAnswers.delete(key);
  }

  async openQuiz(quizId: string, openedAt: string) {
    const quiz = this.quizzes.get(quizId);
    if (!quiz) throw new NotFoundError();
    if (this.openQuizId !== undefined) throw new QuizAlreadyOpenError();
    if (quiz.status !== "draft") throw new InvalidStateError();
    this.openQuizId = quizId;
    Object.assign(quiz, { status: "open", openedAt, updatedAt: openedAt });
    return clone(quiz);
  }

  async closeQuiz(quizId: string, closedAt: string) {
    const quiz = this.quizzes.get(quizId);
    if (!quiz) throw new NotFoundError();
    if (quiz.status !== "open" || this.openQuizId !== quizId) throw new InvalidStateError();
    this.openQuizId = undefined;
    Object.assign(quiz, { status: "closed", closedAt, updatedAt: closedAt });
    return clone(quiz);
  }

  async getOpenQuizId() {
    return this.openQuizId;
  }

  async putQuizAnswer(answer: QuizAnswerRecord) {
    if (this.quizzes.get(answer.quizId)?.status !== "open") throw new InvalidStateError();
    this.quizAnswers.set(`${answer.userId}#${answer.quizId}`, clone(answer));
  }

  async getQuizAnswer(userId: string, quizId: string) {
    return clone(this.quizAnswers.get(`${userId}#${quizId}`));
  }

  async listQuizAnswersByUser(userId: string) {
    return [...this.quizAnswers.values()].filter((a) => a.userId === userId).map(clone);
  }

  async listQuizAnswersByQuiz(quizId: string) {
    return [...this.quizAnswers.values()].filter((a) => a.quizId === quizId).map(clone);
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

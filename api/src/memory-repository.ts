import type { PhotoStatus, Settings } from "@partally/shared";
import {
  DEFAULT_SETTINGS,
  EpithetTakenError,
  formatLabel,
  InvalidStateError,
  NotFoundError,
  type Page,
  type PhotoRecord,
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
    if (!token || token.status !== "unbound") throw new TokenNotAvailableError();
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
    if (!user || user.status !== "active" || !user.token) throw new NotFoundError();
    const token = this.tokens.get(user.token);
    if (!token || token.userId !== userId) throw new NotFoundError();

    this.tokens.set(token.token, { token: token.token, label: token.label, status: "unbound", createdAt: token.createdAt });
    const { token: _removed, ...rest } = user;
    const updated: UserRecord = { ...rest, status: "unbound", updatedAt };
    this.users.set(userId, updated);
    return clone(updated);
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

  async deleteApprovedPhoto(photoId: string) {
    const photo = this.photos.get(photoId);
    if (!photo) throw new NotFoundError();
    if (photo.status !== "approved") throw new InvalidStateError();
    this.photos.delete(photoId);
    const user = this.userOf(photo);
    user.uploadCount--;
    user.approvedCount--;
    return clone(photo);
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

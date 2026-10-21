import type { FavoriteResponse, PhotoDto } from "@partally/shared";
import { useState } from "react";
import { ApiError, api, errorMessage } from "../api";
import { useParticipant } from "./ParticipantLayout";

/**
 * お気に入りの付け外しボタン。自分の写真には出さない。
 * 受付が終わっている・上限に達しているときは押せない（選んだ状態は見える）。
 */
export function FavoriteButton(props: {
  photo: PhotoDto;
  onChange: (photo: PhotoDto) => void;
  /** 一覧のサムネイル上に重ねる小さな表示にする */
  compact?: boolean;
}) {
  const { photo, onChange, compact = false } = props;
  const { user, rules, setUser, reloadUser } = useParticipant();
  const [busy, setBusy] = useState(false);

  if (photo.uploaderId === user.userId) return null;

  const favorited = photo.favorited === true;
  const full = !favorited && user.favoritesGiven >= rules.favoriteLimit;
  const disabled = busy || !rules.favoritesEnabled || full;
  const title = !rules.favoritesEnabled
    ? "お気に入りの受付は終了しました"
    : full
      ? `お気に入りは ${rules.favoriteLimit} 枚まで選べます`
      : favorited
        ? "お気に入りを外す"
        : "お気に入りに選ぶ";

  async function toggle() {
    setBusy(true);
    try {
      const res = await api<FavoriteResponse>(favorited ? "DELETE" : "PUT", `/photos/${photo.photoId}/favorite`);
      onChange(res.photo);
      setUser(res.user);
    } catch (e) {
      alert(errorMessage(e));
      // 受付が終わった・上限が変わったなど、手元のルールが古いので取り直す
      if (e instanceof ApiError && (e.code === "favorites_disabled" || e.code === "favorite_limit")) reloadUser();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`favorite${favorited ? " on" : ""}${compact ? " compact" : ""}`}
      onClick={(e) => {
        // サムネイルの上に重ねたときに、写真の拡大表示が開かないようにする
        e.stopPropagation();
        void toggle();
      }}
      disabled={disabled}
      aria-pressed={favorited}
      aria-label={title}
      title={title}
    >
      {favorited ? "♥" : "♡"}
      {!compact && <span>{favorited ? "お気に入り" : "お気に入りに選ぶ"}</span>}
    </button>
  );
}

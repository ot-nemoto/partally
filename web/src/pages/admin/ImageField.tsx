import { GAME_CHOICE_IMAGE_MAX_EDGE, PRIZE_IMAGE_MAX_EDGE } from "@partally/shared";
import { useRef, useState } from "react";
import { useT } from "../../i18n";
import { processImage } from "../../photos/process";

/**
 * 編集中の画像。imageId は保存済みの画像、blob は新しく選んだ画像（縮小済み）。
 * url は表示用（保存済みなら署名付き URL、新しく選んだならその場で作った URL）。何も無ければ画像なし
 */
export interface ImageDraft {
  imageId?: string;
  blob?: Blob;
  url?: string;
}

/**
 * 種類ごとの見た目と縮小の大きさ。景品の画像は形がまちまちなので、枠に収めて全体を見せる。
 * ゲームの問題・選択肢の画像は四角く切り抜いて見せる（選択肢は小さく出し、縮小も小さめにする）
 */
const VARIANTS = {
  game: {
    field: "game-image-field",
    body: "game-image-field-body",
    preview: "game-image-preview",
    actions: "game-image-actions",
    placeholder: "🖼",
    remove: ["外す", "Remove"],
    maxEdge: PRIZE_IMAGE_MAX_EDGE,
  },
  choice: {
    field: "game-image-field small",
    body: "game-image-field-body",
    preview: "game-image-preview",
    actions: "game-image-actions",
    placeholder: "🖼",
    remove: ["外す", "Remove"],
    maxEdge: GAME_CHOICE_IMAGE_MAX_EDGE,
  },
  prize: {
    field: "",
    body: "prize-image-field",
    preview: "prize-image",
    actions: "prize-image-actions",
    placeholder: "🎁",
    remove: ["画像を外す", "Remove image"],
    maxEdge: PRIZE_IMAGE_MAX_EDGE,
  },
} as const;

/**
 * 画像を選ぶ・変える・外す（景品・ゲームで共通）。選んだ画像は端末で縮小・JPEG にしてから持つ
 * （アップロードは保存のとき。ImageUploads を使う）
 */
export function ImageField(props: {
  label: string;
  image: ImageDraft;
  onChange: (image: ImageDraft) => void;
  /** 新しく作った表示用 URL（呼び出し側が閉じるときに解放する） */
  onPicked: (url: string) => void;
  /** 縮小を始めた（true）・終えた（false）。その間は保存させないときに使う（欄がいくつもある画面は、数を数える） */
  onProcessing?: (processing: boolean) => void;
  disabled?: boolean;
  variant?: keyof typeof VARIANTS;
}) {
  const { image } = props;
  const v = VARIANTS[props.variant ?? "game"];
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();

  async function pick(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    props.onProcessing?.(true);
    setError(undefined);
    try {
      const blob = await processImage(file, v.maxEdge);
      const url = URL.createObjectURL(blob);
      props.onPicked(url);
      props.onChange({ blob, url });
    } catch {
      setError(
        t(
          "画像を読み込めませんでした。別の画像を選んでください。",
          "The image couldn’t be read. Please choose another.",
        ),
      );
    } finally {
      setProcessing(false);
      props.onProcessing?.(false);
    }
  }

  return (
    <div className={v.field ? `field ${v.field}` : "field"}>
      <span>{props.label}</span>
      <div className={v.body}>
        {image.url ? (
          <img className={v.preview} src={image.url} alt={t("選んだ画像", "Chosen image")} />
        ) : (
          <span className={`${v.preview} placeholder`} aria-hidden="true">
            {v.placeholder}
          </span>
        )}
        <div className={v.actions}>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={processing || props.disabled}
            aria-label={
              image.url
                ? t(`${props.label}を変える`, `Change ${props.label}`)
                : t(`${props.label}を選ぶ`, `Choose ${props.label}`)
            }
          >
            {processing
              ? t("読み込み中…", "Loading…")
              : image.url
                ? t("画像を変える", "Change image")
                : t("画像を選ぶ", "Choose image")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.heic,.heif"
            hidden
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {image.url && (
            <button
              type="button"
              className="link"
              onClick={() => props.onChange({})}
              disabled={props.disabled}
              aria-label={t(`${props.label}を外す`, `Remove ${props.label}`)}
            >
              {t(v.remove[0], v.remove[1])}
            </button>
          )}
        </div>
      </div>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

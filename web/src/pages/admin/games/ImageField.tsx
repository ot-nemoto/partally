import { GAME_CHOICE_IMAGE_MAX_EDGE, PRIZE_IMAGE_MAX_EDGE } from "@partally/shared";
import { useRef, useState } from "react";
import { processImage } from "../../../photos/process";

/**
 * 編集中の画像。imageId は保存済みの画像、blob は新しく選んだ画像（縮小済み）。
 * url は表示用（保存済みなら署名付き URL、新しく選んだならその場で作った URL）。何も無ければ画像なし
 */
export interface ImageDraft {
  imageId?: string;
  blob?: Blob;
  url?: string;
}

/** 画像を選ぶ・変える・外す。選んだ画像は端末で縮小・JPEG にしてから持つ（アップロードは保存のとき） */
export function ImageField(props: {
  label: string;
  image: ImageDraft;
  onChange: (image: ImageDraft) => void;
  /** 新しく作った表示用 URL（呼び出し側が閉じるときに解放する） */
  onPicked: (url: string) => void;
  disabled?: boolean;
  /** 選択肢の画像（小さく出し、縮小も小さめにする） */
  small?: boolean;
}) {
  const { image } = props;
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    setError(undefined);
    try {
      const blob = await processImage(file, props.small ? GAME_CHOICE_IMAGE_MAX_EDGE : PRIZE_IMAGE_MAX_EDGE);
      const url = URL.createObjectURL(blob);
      props.onPicked(url);
      props.onChange({ blob, url });
    } catch {
      setError("画像を読み込めませんでした。別の画像を選んでください。");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className={`field game-image-field${props.small ? " small" : ""}`}>
      <span>{props.label}</span>
      <div className="game-image-field-body">
        {image.url ? (
          <img className="game-image-preview" src={image.url} alt="選んだ画像" />
        ) : (
          <span className="game-image-preview placeholder" aria-hidden="true">
            🖼
          </span>
        )}
        <div className="game-image-actions">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={processing || props.disabled}
            aria-label={`${props.label}を${image.url ? "変える" : "選ぶ"}`}
          >
            {processing ? "読み込み中…" : image.url ? "画像を変える" : "画像を選ぶ"}
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
              aria-label={`${props.label}を外す`}
            >
              外す
            </button>
          )}
        </div>
      </div>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

import { useId } from "react";

/**
 * 0 以上の整数の入力欄。入力中は空欄にでき（このとき onChange には NaN を渡す）、
 * 先頭の 0 は取り除く（0 の後に 1 を押すと 1 になる）。全角数字は半角にし、数字以外が混ざった入力は受け付けず、上限を超えたら上限にする
 */
export function NumberField(props: {
  label: string;
  value: number;
  max: number;
  /** 案内に出す下限（入力は 0 も受け付け、下限の確認は呼び出し側で行う） */
  min?: number;
  onChange: (value: number) => void;
}) {
  const hintId = useId();
  const text = Number.isNaN(props.value) ? "" : String(props.value);
  return (
    <label className="field number-field">
      <span>{props.label}</span>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        value={text}
        onChange={(e) => {
          const digits = e.target.value.normalize("NFKC").trim();
          // 「2.5」「-3」などを数字だけ拾って別の数にしないよう、数字以外が混ざった入力は無視する
          if (!/^[0-9]*$/.test(digits)) return;
          props.onChange(digits === "" ? Number.NaN : Math.min(props.max, Number(digits)));
        }}
        aria-describedby={hintId}
        required
      />
      <span id={hintId} className="muted small">
        {props.min ?? 0}〜{props.max}
      </span>
    </label>
  );
}

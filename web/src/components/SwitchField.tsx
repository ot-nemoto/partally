import type { ReactNode } from "react";

/**
 * オン／オフの設定。role="switch" のチェックボックスを CSS でトグルスイッチの見た目にする（キーボード操作と読み上げはそのまま）。
 * description があれば label を太字にして下に説明を添える
 */
export function SwitchField(props: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={props.checked}
        // ネイティブの checked と同じ値（role="switch" に必須の属性として付ける）
        aria-checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.description === undefined ? (
        <span>{props.label}</span>
      ) : (
        <span>
          <strong>{props.label}</strong>
          <span className="muted small">{props.description}</span>
        </span>
      )}
    </label>
  );
}

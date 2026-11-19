/** 英語の順位（景品の順位・ゲームの点数の範囲）。（1st, 2nd, 3rd, 4th, 11th, 21st…） */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/** 英語の順位の範囲（1st, 2nd–3rd） */
export function ordinalRange(from: number, to: number): string {
  return from === to ? ordinal(from) : `${ordinal(from)}–${ordinal(to)}`;
}

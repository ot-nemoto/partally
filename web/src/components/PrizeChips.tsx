import type { PrizeDto } from "@partally/shared";

/** 景品の画像。画像が無ければ箱の絵を出す */
export function PrizeImage({ prize, small = false }: { prize: PrizeDto; small?: boolean }) {
  const className = small ? "prize-image small" : "prize-image";
  return prize.imageUrl ? (
    <img className={className} src={prize.imageUrl} alt="" loading="lazy" />
  ) : (
    <span className={`${className} placeholder`} aria-hidden="true">
      🎁
    </span>
  );
}

/** 景品を小さな画像と名前で横に並べる（順位の表・ランキングの行に添える） */
export function PrizeChips({ prizes }: { prizes: PrizeDto[] }) {
  return (
    <ul className="prize-chips">
      {prizes.map((p) => (
        <li key={p.prizeId}>
          <PrizeImage prize={p} small />
          <span>{p.name}</span>
        </li>
      ))}
    </ul>
  );
}

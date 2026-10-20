import type { TokenDto, TokensResponse } from "@partally/shared";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api, errorMessage } from "../../api";

interface Card {
  token: TokenDto;
  /** QR コードの SVG を data URL にしたもの（拡大・印刷しても粗くならない） */
  src: string;
}

/** QR コードを並べた印刷用ページ。ブラウザの印刷機能で PDF 化・印刷する */
export function AdminTokensPrint() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const onlyUnbound = params.get("filter") === "unbound";
  const [cards, setCards] = useState<Card[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async () => {
      const { tokens } = await api<TokensResponse>("GET", "/admin/tokens");
      const targets = onlyUnbound ? tokens.filter((t) => t.status === "unbound") : tokens;
      const rendered = await Promise.all(
        targets.map(async (token) => ({
          token,
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
            await QRCode.toString(`${location.origin}/q/${token.token}`, {
              type: "svg",
              errorCorrectionLevel: "M",
              margin: 1,
            }),
          )}`,
        })),
      );
      setCards(rendered);
    })().catch((e) => {
      if (e instanceof ApiError && e.status === 401) navigate("/admin/login", { replace: true });
      else setError(errorMessage(e));
    });
  }, [onlyUnbound, navigate]);

  return (
    <main className="print-page">
      <div className="no-print print-toolbar">
        <span>
          {onlyUnbound ? "未使用" : "全件"} {cards?.length ?? "…"} 枚
        </span>
        <button type="button" className="primary" onClick={() => window.print()} disabled={!cards}>
          印刷
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="qr-grid">
        {cards?.map(({ token, src }) => (
          <div key={token.token} className="qr-card">
            <img className="qr" src={src} alt={`QR コード No. ${token.label}`} />
            <p className="qr-label">No. {token.label}</p>
            <p className="qr-hint">スマホのカメラで読み込んでください</p>
          </div>
        ))}
      </div>
    </main>
  );
}

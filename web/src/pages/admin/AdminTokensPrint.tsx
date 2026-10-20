import type { TokenDto, TokensResponse } from "@partally/shared";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api, errorMessage } from "../../api";

interface Card {
  token: TokenDto;
  svg: string;
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
          svg: await QRCode.toString(`${location.origin}/q/${token.token}`, {
            type: "svg",
            errorCorrectionLevel: "M",
            margin: 1,
          }),
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
        {cards?.map(({ token, svg }) => (
          <div key={token.token} className="qr-card">
            {/* qrcode ライブラリが生成した SVG なので埋め込んで問題ない */}
            <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
            <p className="qr-label">No. {token.label}</p>
            <p className="qr-hint">スマホのカメラで読み込んでください</p>
          </div>
        ))}
      </div>
    </main>
  );
}

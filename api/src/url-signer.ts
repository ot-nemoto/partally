import { createSign } from "node:crypto";

/** 写真を見る権限を与える署名。公開済みは Cookie、検閲待ちは個別の署名付き URL で渡す */
export interface UrlSigner {
  /** 公開済み写真（/photos/approved/*）を見るための Cookie（名前 → 値） */
  approvedCookies(expiresAt: Date): Record<string, string>;
  /** 同一オリジンの path に署名クエリを付けた URL を返す */
  signPath(path: string, expiresAt: Date): string;
}

/**
 * CloudFront のカスタムポリシーによる署名。
 * Resource のホスト部はワイルドカードにし、API がディストリビューションのドメインを知らなくてよいようにする
 * （キーグループはこのディストリビューション専用なので他所では使えない）。
 */
export class CloudFrontSigner implements UrlSigner {
  constructor(
    private readonly keyPairId: string,
    private readonly privateKeyPem: string,
  ) {}

  approvedCookies(expiresAt: Date) {
    const { policy, signature } = this.sign("https://*/photos/approved/*", expiresAt);
    return {
      "CloudFront-Policy": policy,
      "CloudFront-Signature": signature,
      "CloudFront-Key-Pair-Id": this.keyPairId,
    };
  }

  signPath(path: string, expiresAt: Date) {
    const { policy, signature } = this.sign(`https://*${path}`, expiresAt);
    const query = new URLSearchParams({ Policy: policy, Signature: signature, "Key-Pair-Id": this.keyPairId });
    return `${path}?${query}`;
  }

  private sign(resource: string, expiresAt: Date) {
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: resource,
          Condition: { DateLessThan: { "AWS:EpochTime": Math.floor(expiresAt.getTime() / 1000) } },
        },
      ],
    });
    const signature = createSign("RSA-SHA1").update(policy).sign(this.privateKeyPem);
    return { policy: urlSafeBase64(Buffer.from(policy)), signature: urlSafeBase64(signature) };
  }
}

/** ローカル開発用。署名せずにパスをそのまま返す */
export class NoopSigner implements UrlSigner {
  approvedCookies() {
    return {};
  }

  signPath(path: string) {
    return path;
  }
}

/** CloudFront 独自の URL セーフ Base64（+ → -、= → _、/ → ~） */
function urlSafeBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~");
}

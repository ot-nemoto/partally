import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudFrontSigner } from "./url-signer.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signer = new CloudFrontSigner("K123", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
const expiresAt = new Date("2026-12-24T12:00:00Z");

function decode(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");
}

function assertValid(policy: string, signature: string) {
  const ok = createVerify("RSA-SHA1").update(decode(policy)).verify(publicKey, decode(signature));
  expect(ok).toBe(true);
}

describe("CloudFrontSigner", () => {
  it("公開写真用の Cookie はワイルドカードのリソースと有効期限を持つカスタムポリシーで署名する", () => {
    const cookies = signer.approvedCookies(expiresAt);
    expect(cookies["CloudFront-Key-Pair-Id"]).toBe("K123");
    // CloudFront の URL セーフ Base64 は + = / を含まない
    expect(cookies["CloudFront-Policy"]).not.toMatch(/[+=/]/);

    const policy = JSON.parse(decode(cookies["CloudFront-Policy"]).toString());
    expect(policy.Statement[0]).toEqual({
      Resource: "https://*/photos/approved/*",
      Condition: { DateLessThan: { "AWS:EpochTime": expiresAt.getTime() / 1000 } },
    });
    assertValid(cookies["CloudFront-Policy"], cookies["CloudFront-Signature"]);
  });

  it("署名付き URL はパス専用のポリシーをクエリに付ける", () => {
    const url = new URL(signer.signPath("/photos/pending/P1/thumb.jpg", expiresAt), "https://example.com");
    expect(url.pathname).toBe("/photos/pending/P1/thumb.jpg");
    expect(url.searchParams.get("Key-Pair-Id")).toBe("K123");

    const policy = url.searchParams.get("Policy")!;
    expect(JSON.parse(decode(policy).toString()).Statement[0].Resource).toBe(
      "https://*/photos/pending/P1/thumb.jpg",
    );
    assertValid(policy, url.searchParams.get("Signature")!);
  });
});

import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

/**
 * 暗証番号のハッシュ。`scrypt$<salt>$<hash>`（base64url）の形で保存する。
 * 4 桁の番号は総当たりで当てられるので、守りの中心はロック（間違えられる回数）で、ハッシュは保存した値から
 * 番号がそのまま読めないようにするためのもの
 */
const KEY_LENGTH = 32;
const OPTIONS: ScryptOptions = { N: 16384, r: 8, p: 1 };

function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pin, salt, KEY_LENGTH, OPTIONS, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pin, salt);
  return ["scrypt", salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await derive(pin, Buffer.from(salt, "base64url"));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

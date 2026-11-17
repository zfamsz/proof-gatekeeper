/**
 * HMAC-SHA256 signing / verification over raw request/response bodies.
 *
 * OFFICIAL (RESEARCH.md §1.5): verify `x-agent-games-signature` against
 * the RAW body BEFORE parsing JSON; sign every response over the raw
 * response body. Algorithm/encoding are officially unstated; the
 * best-supported reading (two live preflight passes) is HMAC-SHA256,
 * lowercase hex outbound. Inbound we defensively accept hex, base64, and
 * an optional `sha256=` prefix, compared in constant time.
 */
import * as crypto from "crypto";

export const SIGNATURE_HEADER = "x-agent-games-signature";

/** Sign raw bytes; returns lowercase hex HMAC-SHA256. */
export function signBody(secret: Buffer, body: Buffer): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Decode a presented signature value into raw MAC bytes, accepting:
 *  - lowercase/uppercase hex (with optional `sha256=` prefix)
 *  - base64
 * Returns null when the value decodes to nothing plausible.
 */
export function decodeSignature(value: string): Buffer | null {
  let v = value.trim();
  if (v.toLowerCase().startsWith("sha256=")) v = v.slice("sha256=".length);
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
    return Buffer.from(v, "hex");
  }
  try {
    const decoded = Buffer.from(v, "base64");
    // Base64 of a 32-byte MAC is 44 chars ending in "="; reject junk that
    // round-trips to something else.
    if (decoded.length === 32 && decoded.toString("base64") === v) {
      return decoded;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Verify an inbound signature in constant time. `headerValue` may be
 * undefined (missing header -> false). Never throws on malformed input.
 */
export function verifySignature(
  secret: Buffer,
  body: Buffer,
  headerValue: string | string[] | undefined,
): boolean {
  return verifySignatureMulti([secret], body, headerValue) !== null;
}

/**
 * Verify against several candidate keys (see secretKeys in config.ts).
 * Returns the key that matched, or null. Lets the server answer with the
 * same key encoding the platform used to sign, so response signatures stay
 * consistent with the platform's convention.
 */
export function verifySignatureMulti(
  keys: Buffer[],
  body: Buffer,
  headerValue: string | string[] | undefined,
): Buffer | null {
  if (typeof headerValue !== "string") return null;
  const presented = decodeSignature(headerValue);
  if (presented === null) return null;
  for (const key of keys) {
    const expected = crypto.createHmac("sha256", key).update(body).digest();
    if (
      presented.length === expected.length &&
      crypto.timingSafeEqual(presented, expected)
    ) {
      return key;
    }
  }
  return null;
}

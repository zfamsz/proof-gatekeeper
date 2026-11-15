/**
 * Configuration — every env var, constant, and UNVERIFIED assumption in
 * one place. Nothing in this file is a secret value: secrets come from
 * process.env only, and are never logged.
 *
 * Source of truth: RESEARCH.md. Where RESEARCH.md marks a detail
 * UNVERIFIED (§7), the corresponding knob lives here with a TODO comment
 * and the default is the best-supported / fail-closed choice. The full
 * list is repeated in README.md ("Unverified protocol details").
 */
import * as crypto from "crypto";
import * as dotenv from "dotenv";
import { keccak256 } from "js-sha3";

dotenv.config();

// ---------------------------------------------------------------------------
// Verified constants (RESEARCH.md §4–§5)
// ---------------------------------------------------------------------------

/** BN128 scalar field prime. */
export const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/** Registered gatekeeper verification-key hash (mainnet, circuit-info). */
export const REGISTERED_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

/** Registered vkHash reduced mod p — the value that appears in signals[1..2]. */
export const REGISTERED_VK_HASH_MOD_P = (
  BigInt(REGISTERED_VK_HASH) % FIELD_PRIME
).toString();
// == "4836144126773920907502496244340012141761656471453348073975163706578152814510"

/** Expected circuit artifacts (RESEARCH.md §4). Verified at startup. */
export const EXPECTED_ARTIFACTS = {
  wasm: {
    file: "gatekeeper.wasm",
    size: 1_755_820,
    sha256:
      "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f",
    url: "https://agentgames.zkverify.io/circuits/gatekeeper.wasm",
  },
  zkey: {
    file: "gatekeeper_final.zkey",
    size: 309_750,
    sha256:
      "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d",
    url: "https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey",
  },
  vkey: {
    file: "gatekeeper.vkey.json",
    size: 5_117,
    sha256:
      "6ce4899b3bc74d6a5c10ede61daf8820716982e1ef7e6778a5a8872ddaf28221",
  },
} as const;

/** Kurier mainnet base URL (RESEARCH.md §2). */
export const KURIER_MAINNET_URL = "https://api.kurier.xyz/api/v1";

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}=${raw}: expected a non-negative integer`);
  }
  return n;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export type ZkVerifyMode = "local" | "kurier";
export type TaskIdHash = "sha256" | "keccak256";

export interface Config {
  port: number;
  /** Raw secret string from env (never logged). Decoded by secretBytes(). */
  hmacSecretRaw: string;
  kurierApiKey: string;
  zkVerifyMode: ZkVerifyMode;
  requireFinalized: boolean;
  taskIdHash: TaskIdHash;
  saltDerivation: string;
  kurierBaseUrl: string;
  kurierPollBudgetMs: number;
  kurierPollIntervalMs: number;
  /** Hard per-request deadline (official: 60 s end-to-end). */
  requestTimeoutMs: number;
  /** Max age of a task at receipt (TODO §7.1: window is unpublished). */
  maxTaskAgeMs: number;
  /** Allowed clock skew for a future issued_at. */
  clockSkewMs: number;
  /** Max raw request body size. */
  maxBodyBytes: number;
  circuitDir: string | undefined;
}

function parseMode(raw: string): ZkVerifyMode {
  if (raw === "local" || raw === "kurier") return raw;
  throw new Error(
    `Invalid ZKVERIFY_MODE=${raw}: expected "local" or "kurier"`,
  );
}

function parseTaskIdHash(raw: string): TaskIdHash {
  if (raw === "sha256" || raw === "keccak256") return raw;
  throw new Error(
    `Invalid TASK_ID_HASH=${raw}: expected "sha256" or "keccak256"`,
  );
}

export function loadConfig(): Config {
  const hmacSecretRaw = process.env.AGENT_GAMES_HMAC_SECRET;
  if (!hmacSecretRaw) {
    // Security checklist item (8): the secret must be the platform-
    // generated value, never a local placeholder. Refuse to start without it.
    throw new Error(
      "AGENT_GAMES_HMAC_SECRET is not set. Set it to the platform-generated " +
        "32-byte secret from the Agent Games dashboard (Rotate Secret). " +
        "The server refuses to start without a real secret.",
    );
  }
  const zkVerifyMode = parseMode(envString("ZKVERIFY_MODE", "local"));
  const kurierApiKey = envString("KURIER_API_KEY", "");
  if (zkVerifyMode === "kurier" && !kurierApiKey) {
    throw new Error(
      "ZKVERIFY_MODE=kurier requires KURIER_API_KEY (from https://kurier.xyz).",
    );
  }
  return {
    port: envInt("PORT", 3000),
    hmacSecretRaw,
    kurierApiKey,
    zkVerifyMode,
    requireFinalized:
      envString("REQUIRE_FINALIZED", "true").toLowerCase() !== "false",
    taskIdHash: parseTaskIdHash(envString("TASK_ID_HASH", "sha256")),
    saltDerivation: envString("SALT_DERIVATION", "hmac"),
    kurierBaseUrl: envString("KURIER_BASE_URL", KURIER_MAINNET_URL),
    kurierPollBudgetMs: envInt("KURIER_POLL_BUDGET_MS", 20_000),
    kurierPollIntervalMs: envInt("KURIER_POLL_INTERVAL_MS", 2_000),
    requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 60_000),
    maxTaskAgeMs: envInt("MAX_TASK_AGE_MS", 600_000),
    clockSkewMs: envInt("CLOCK_SKEW_MS", 300_000),
    maxBodyBytes: envInt("MAX_BODY_BYTES", 1_048_576),
    circuitDir: process.env.CIRCUIT_DIR || undefined,
  };
}

// ---------------------------------------------------------------------------
// HMAC secret decoding (TODO §7.8 — UNVERIFIED)
// ---------------------------------------------------------------------------
// The official docs never state how the 32-byte secret is encoded as the
// HMAC key. Accepted, in order: 64-char hex, base64 decoding to 32 bytes,
// otherwise the raw UTF-8 bytes of the env value. If preflight fails with
// FAILED (protocol), the encoding is the first thing to vary.

export function secretBytes(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 32) return decoded;
    } catch {
      // fall through to UTF-8
    }
  }
  return Buffer.from(trimmed, "utf8");
}

// ---------------------------------------------------------------------------
// Field-element helpers
// ---------------------------------------------------------------------------

export function modP(value: bigint): bigint {
  const r = value % FIELD_PRIME;
  return r < 0n ? r + FIELD_PRIME : r;
}

/** Parse a decimal string / number / 0x-hex string into a field element. */
export function toField(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return modP(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`Expected integer field value, got ${value}`);
    }
    return modP(BigInt(value));
  }
  const s = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return modP(BigInt(s));
  if (/^-?\d+$/.test(s)) return modP(BigInt(s));
  throw new Error(`Cannot parse field value: ${value}`);
}

// ---------------------------------------------------------------------------
// task_id -> field element (TODO §7.7 — CONTESTED, UNVERIFIED)
// ---------------------------------------------------------------------------
// andruu21: SHA-256(task_id) mod p (claims 4/4 practice tasks).
// subastian1998: keccak256(task_id) mod p (flagged as an open item).
// Local proving cannot distinguish them — any field element is a valid
// circuit input. Default sha256 (only option with practice-task evidence);
// switch with TASK_ID_HASH and confirm against the first practice task.

export function taskIdToField(taskId: string, algo: TaskIdHash): bigint {
  if (algo === "keccak256") {
    return modP(BigInt("0x" + keccak256(taskId)));
  }
  const digest = crypto
    .createHash("sha256")
    .update(taskId, "utf8")
    .digest("hex");
  return modP(BigInt("0x" + digest));
}

// ---------------------------------------------------------------------------
// Salt derivation (TODO §7.6 — UNVERIFIED participant convention)
// ---------------------------------------------------------------------------
// Default: salt = HMAC(secret, "gatekeeper-salt:" + task_id) mod p.
// Deterministic per task, so a same-task_id retry reproduces identical
// proof inputs. Any salt proves locally; whether the platform recomputes
// the Poseidon(salt, taskId) commitment — and with what salt — is unknown.
// Keep this a single function so it is easy to swap.

export function deriveSalt(
  taskId: string,
  secret: Buffer,
  scheme: string,
): bigint {
  if (scheme !== "hmac") {
    throw new Error(
      `Unknown SALT_DERIVATION=${scheme}: only "hmac" is supported`,
    );
  }
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`gatekeeper-salt:${taskId}`, "utf8")
    .digest();
  return modP(BigInt("0x" + mac.toString("hex")));
}

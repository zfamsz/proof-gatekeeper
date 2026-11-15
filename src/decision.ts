/**
 * Deterministic decision checklist — pure function, no I/O, no model
 * calls, fail-closed. The circuit enforces the same five field checks
 * (RESEARCH.md §1.3, §5): a wrong decision is UNPROVABLE, so the
 * decision computed here must match the circuit or proving fails.
 *
 * APPROVE only if ALL of:
 *   proof_vk == registered_vk
 *   proof_tx not already used (under a DIFFERENT task_id — same-task_id
 *   retries are idempotent, handled in server.ts before this runs)
 *   public_balance >= minimum        (boundary: equal is VALID)
 *   current_block < expiry_block     (boundary: equal is EXPIRED)
 *   recipient == condition_recipient
 *   amount <= max_transfer           (boundary: equal is VALID)
 *
 * Check order is fixed and documented: VK, reuse, threshold, expiry,
 * recipient, amount. The first failing check determines the reason_code
 * (official taxonomy, RESEARCH.md §1.3).
 *
 * NOTE on PROOF_REUSED: reuse is not a circuit input. If all five field
 * checks pass but proof_tx was already used, the correct decision is
 * REJECT — but decision=0 on otherwise-valid inputs is unprovable
 * (witness generation fails). So PROOF_REUSED tasks have NO proof to
 * submit (RESEARCH.md §1.4); the server returns the REJECT without
 * proof/public_signals for this code only.
 */
import type { GatekeeperInput, OfficialReasonCode } from "./types";
import { InvalidEnvelopeError } from "./types";

export interface DecisionResult {
  decision: "APPROVE" | "REJECT";
  reasonCode: OfficialReasonCode;
  /** The failing check, or null when every check passed. */
  failedCheck: string | null;
}

const HEX_40 = /^0x[0-9a-fA-F]{40}$/;
const HEX_ANY = /^0x[0-9a-fA-F]+$/;
const DECIMAL = /^\d+$/;

function requireField(input: GatekeeperInput, name: keyof GatekeeperInput): void {
  const v = input[name];
  if (v === undefined || v === null || v === "") {
    throw new InvalidEnvelopeError(`Missing input field: ${name}`);
  }
}

function parseDecimal(value: string, name: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value.trim())) {
    throw new InvalidEnvelopeError(
      `Field ${name} must be a decimal string, got: ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value.trim());
}

function parseBlock(value: number, name: string): bigint {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidEnvelopeError(
      `Field ${name} must be a non-negative JSON integer, got: ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

/** Validate the envelope's input shape; throws InvalidEnvelopeError. */
export function validateInput(input: unknown): GatekeeperInput {
  if (typeof input !== "object" || input === null) {
    throw new InvalidEnvelopeError("Missing or non-object input");
  }
  const inp = input as GatekeeperInput;
  const fields: (keyof GatekeeperInput)[] = [
    "registered_vk",
    "proof_vk",
    "minimum",
    "public_balance",
    "expiry_block",
    "current_block",
    "recipient",
    "condition_recipient",
    "amount",
    "max_transfer",
    "proof_tx",
  ];
  for (const f of fields) requireField(inp, f);
  for (const f of ["registered_vk", "proof_vk", "proof_tx"] as const) {
    if (!HEX_ANY.test(inp[f])) {
      throw new InvalidEnvelopeError(`Field ${f} must be a 0x hex string`);
    }
  }
  for (const f of ["recipient", "condition_recipient"] as const) {
    if (!HEX_40.test(inp[f])) {
      throw new InvalidEnvelopeError(
        `Field ${f} must be a 0x 40-hex-char address`,
      );
    }
  }
  // Parse numeric fields now so malformed values fail before any proving.
  parseDecimal(inp.minimum, "minimum");
  parseDecimal(inp.public_balance, "public_balance");
  parseDecimal(inp.amount, "amount");
  parseDecimal(inp.max_transfer, "max_transfer");
  parseBlock(inp.expiry_block, "expiry_block");
  parseBlock(inp.current_block, "current_block");
  return inp;
}

export function evaluateDecision(
  input: GatekeeperInput,
  isProofReused: boolean,
): DecisionResult {
  // (1) VK matches the registered key.
  if (input.proof_vk.toLowerCase() !== input.registered_vk.toLowerCase()) {
    return { decision: "REJECT", reasonCode: "VK_SUBSTITUTION", failedCheck: "vk" };
  }
  // (4) Proof reference not already used (under a different task_id).
  if (isProofReused) {
    return { decision: "REJECT", reasonCode: "PROOF_REUSED", failedCheck: "reuse" };
  }
  // (3a) Threshold: public_balance >= minimum.
  if (
    parseDecimal(input.public_balance, "public_balance") <
    parseDecimal(input.minimum, "minimum")
  ) {
    return { decision: "REJECT", reasonCode: "THRESHOLD_MISMATCH", failedCheck: "threshold" };
  }
  // (3b) Expiry: current_block < expiry_block (strict).
  if (
    parseBlock(input.current_block, "current_block") >=
    parseBlock(input.expiry_block, "expiry_block")
  ) {
    return { decision: "REJECT", reasonCode: "EXPIRED_CONDITION", failedCheck: "expiry" };
  }
  // (3c) Recipient matches the condition recipient.
  if (
    input.recipient.toLowerCase() !== input.condition_recipient.toLowerCase()
  ) {
    return { decision: "REJECT", reasonCode: "RECIPIENT_MISMATCH", failedCheck: "recipient" };
  }
  // (3d) Amount within the allowed transfer.
  if (
    parseDecimal(input.amount, "amount") >
    parseDecimal(input.max_transfer, "max_transfer")
  ) {
    return { decision: "REJECT", reasonCode: "AMOUNT_OVERFLOW", failedCheck: "amount" };
  }
  return { decision: "APPROVE", reasonCode: "VALID_CONDITION", failedCheck: null };
}

// ---------------------------------------------------------------------------
// Timestamp parsing (TODO §7.1 — UNVERIFIED)
// ---------------------------------------------------------------------------
// Official sample shows only "<issued-at>" / "<deadline-at>". Accept
// ISO-8601 strings and unix seconds/ms (number or numeric string)
// defensively. Unparseable or past-deadline envelopes are fail-closed
// REJECTs. The staleness window itself is unpublished — MAX_TASK_AGE_MS
// (default 10 min) is a CONFIG guess; tune from the first live tasks.

export function parseTimestamp(value: string | number | unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Unix seconds (< 1e12) vs milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n < 1e12 ? n * 1000 : n;
    }
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export interface TimestampCheck {
  ok: boolean;
  reason: string;
}

/** Fail-closed timestamp validation, run before any proving work. */
export function checkTimestamps(
  issuedAt: unknown,
  deadlineAt: unknown,
  nowMs: number,
  maxAgeMs: number,
  clockSkewMs: number,
): TimestampCheck {
  const issued = parseTimestamp(issuedAt);
  const deadline = parseTimestamp(deadlineAt);
  if (issued === null || deadline === null) {
    return { ok: false, reason: "unparseable issued_at/deadline_at" };
  }
  if (nowMs > deadline) {
    return { ok: false, reason: "past deadline_at" };
  }
  if (issued > nowMs + clockSkewMs) {
    return { ok: false, reason: "issued_at is in the future" };
  }
  if (nowMs - issued > maxAgeMs) {
    return { ok: false, reason: "issued_at is too old" };
  }
  return { ok: true, reason: "" };
}

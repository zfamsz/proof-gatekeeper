/**
 * Shared types for the Proof Gatekeeper service.
 *
 * Envelope / response shapes follow RESEARCH.md §1.2–§1.4 (official Agent
 * Games event page + the live-participant superset response). Anything not
 * in RESEARCH.md is marked CONFIG/TODO in config.ts and listed in the
 * README under "Unverified protocol details".
 */

/** Task envelope, verbatim from the official event page (RESEARCH.md §1.2). */
export interface GatekeeperInput {
  registered_vk: string;
  proof_vk: string;
  minimum: string; // decimal string
  public_balance: string; // decimal string
  expiry_block: number; // JSON number
  current_block: number; // JSON number
  recipient: string; // 0x… hex
  condition_recipient: string; // 0x… hex
  amount: string; // decimal string
  max_transfer: string; // decimal string
  proof_tx: string; // 0x… hex
}

export interface GatekeeperTask {
  type: string;
  task_id: string;
  mode: string;
  /** Format UNVERIFIED (RESEARCH.md §7.1): ISO-8601 or unix seconds/ms. */
  issued_at: string | number;
  /** Format UNVERIFIED (RESEARCH.md §7.1): ISO-8601 or unix seconds/ms. */
  deadline_at: string | number;
  input: GatekeeperInput;
}

export type Decision = "APPROVE" | "REJECT";

/**
 * OFFICIAL reason codes (event page, RESEARCH.md §1.3) — the only seven
 * codes the platform scores:
 *   VALID_CONDITION (APPROVE) and the six REJECT trap codes.
 */
export const OFFICIAL_REASON_CODES = [
  "VALID_CONDITION",
  "VK_SUBSTITUTION",
  "PROOF_REUSED",
  "THRESHOLD_MISMATCH",
  "EXPIRED_CONDITION",
  "RECIPIENT_MISMATCH",
  "AMOUNT_OVERFLOW",
] as const;
export type OfficialReasonCode = (typeof OFFICIAL_REASON_CODES)[number];

/**
 * Off-path fallback codes. NOT in the official taxonomy — expect them to
 * be unscored. Used only when the envelope itself is malformed, stale, or
 * the service hits an internal failure / timeout / non-finalized Kurier
 * submission. RESEARCH.md §7.13 documents INVALID_TASK as a participant
 * invention; STALE_TIMESTAMP / TIMEOUT / INTERNAL_ERROR / NOT_FINALIZED /
 * PROVING_FAILED are this implementation's equivalents for the same
 * off-path situations. Never used for a well-formed, scorable task.
 */
export const FALLBACK_REASON_CODES = [
  "INVALID_TASK",
  "STALE_TIMESTAMP",
  "TIMEOUT",
  "INTERNAL_ERROR",
  "NOT_FINALIZED",
  "PROVING_FAILED",
] as const;
export type FallbackReasonCode = (typeof FALLBACK_REASON_CODES)[number];

export type ReasonCode = OfficialReasonCode | FallbackReasonCode;

/** snarkjs Groth16 proof object, as returned by groth16.fullProve. */
export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

/**
 * Superset response (RESEARCH.md §1.4): what both live participant agents
 * send and what /build demands ("include the proof in your response").
 * The official event page shows only {decision, reason_code, proof_tx};
 * we always send the superset EXCEPT for PROOF_REUSED (no proof exists
 * for that trap — see decision.ts) and off-path failures (no proof).
 *
 * proof_tx: in kurier mode this is OUR proof's on-chain tx hash from
 * Kurier once one exists; in local mode (no submission) it echoes the
 * envelope's proof_tx. RESEARCH.md §1.4 vs the task brief differ on this
 * point — RESEARCH.md wins (own tx when one exists, echo otherwise).
 */
export interface GatekeeperResponse {
  decision: Decision;
  reason_code: ReasonCode;
  proof?: Groth16Proof;
  /** 13 decimal-string field elements, in the verified order (RESEARCH.md §5). */
  public_signals?: string[];
  proof_tx: string;
}

export interface PreflightResponse {
  ok: true;
  protocolVersion: "v1";
}

/** Error thrown when the envelope fails structural validation. */
export class InvalidEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnvelopeError";
  }
}

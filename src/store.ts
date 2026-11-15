/**
 * In-memory store: used proof_tx references + per-task_id idempotency.
 *
 * - A same-task_id retry returns the cached response and is NOT proof
 *   reuse (RESEARCH.md §1.2, rules §1.2).
 * - The same proof_tx under a DIFFERENT task_id IS reuse -> REJECT
 *   PROOF_REUSED.
 * - proof_tx is marked used only once a proof-backed decision response
 *   has been produced (PROOF_REUSED / stale / malformed tasks consume
 *   nothing, because no proof was generated for them).
 *
 * PRODUCTION NOTE: this is in-memory only. A restart loses the used-set
 * and the idempotency cache, which could let a reused proof_tx slip
 * through after a redeploy. Production deployments MUST use durable
 * storage (Redis / Postgres) for both sets. See README "Security notes".
 */
import type { GatekeeperResponse } from "./types";

export class ProofStore {
  private readonly usedProofTx = new Set<string>();
  private readonly taskResponses = new Map<string, GatekeeperResponse>();

  private static normalizeTx(tx: string): string {
    return tx.trim().toLowerCase();
  }

  isProofReused(proofTx: string): boolean {
    return this.usedProofTx.has(ProofStore.normalizeTx(proofTx));
  }

  markProofUsed(proofTx: string): void {
    this.usedProofTx.add(ProofStore.normalizeTx(proofTx));
  }

  getCachedResponse(taskId: string): GatekeeperResponse | undefined {
    return this.taskResponses.get(taskId);
  }

  cacheResponse(taskId: string, response: GatekeeperResponse): void {
    this.taskResponses.set(taskId, response);
  }

  get usedCount(): number {
    return this.usedProofTx.size;
  }

  get cachedTaskCount(): number {
    return this.taskResponses.size;
  }
}

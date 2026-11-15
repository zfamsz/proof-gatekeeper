/**
 * Kurier client (zkVerify REST path, RESEARCH.md §2).
 *
 * Flow: register-vk once -> submit-proof -> poll job-status to Finalized.
 * Only used when ZKVERIFY_MODE=kurier. Default mode is local, so this
 * code never runs (and never spends anything / touches mainnet) unless
 * the user explicitly enables it with a real KURIER_API_KEY.
 *
 * Response-field handling is defensive (RESEARCH.md §7.11): accept
 * vkHash, meta.vkHash, and uniq_vk_hash from register-vk, and assert the
 * returned hash equals the published registered vkHash before submitting.
 */
import { REGISTERED_VK_HASH } from "./config";
import type { Groth16Proof } from "./types";

export type JobStatus =
  | "Queued"
  | "Valid"
  | "Submitted"
  | "IncludedInBlock"
  | "Finalized"
  | "Failed"
  | string;

export interface SubmitOutcome {
  jobId: string;
  /** Last status observed within the poll budget. */
  status: JobStatus;
  /** On-chain tx hash, present once status reaches Submitted or later. */
  txHash: string | null;
  finalized: boolean;
}

const PROOF_OPTIONS = { library: "snarkjs", curve: "bn128" } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    if (!res.ok) {
      throw new Error(
        `Kurier HTTP ${res.status} on ${url}: ${String(text).slice(0, 500)}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export class KurierClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private registeredVkHash: string | null = null;
  private registerPromise: Promise<string> | null = null;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  /** Register the gatekeeper VK once; returns the registered vkHash. */
  async registerVk(vkJson: unknown): Promise<string> {
    if (this.registeredVkHash) return this.registeredVkHash;
    if (!this.registerPromise) {
      this.registerPromise = this.doRegisterVk(vkJson);
    }
    try {
      this.registeredVkHash = await this.registerPromise;
      return this.registeredVkHash;
    } catch (err) {
      this.registerPromise = null;
      throw err;
    }
  }

  private async doRegisterVk(vkJson: unknown): Promise<string> {
    const body = await fetchJson(
      `${this.baseUrl}/register-vk/${this.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofType: "groth16",
          proofOptions: PROOF_OPTIONS,
          vk: vkJson,
        }),
      },
    );
    const rec = body as Record<string, unknown>;
    const nested = (rec.vk ?? rec.meta ?? {}) as Record<string, unknown>;
    const hash =
      (typeof rec.vkHash === "string" && rec.vkHash) ||
      (typeof rec.uniq_vk_hash === "string" && rec.uniq_vk_hash) ||
      (typeof nested.vkHash === "string" && nested.vkHash) ||
      (typeof (rec.meta as Record<string, unknown> | undefined)?.vkHash ===
        "string" &&
        ((rec.meta as Record<string, unknown>).vkHash as string)) ||
      null;
    if (!hash) {
      throw new Error(
        `register-vk returned no vkHash (body: ${JSON.stringify(body).slice(0, 500)})`,
      );
    }
    if (hash.toLowerCase() !== REGISTERED_VK_HASH.toLowerCase()) {
      throw new Error(
        `register-vk returned unexpected vkHash ${hash}; expected ${REGISTERED_VK_HASH}`,
      );
    }
    return hash;
  }

  /** Submit a proof; gates on optimisticVerify === "success" (docs). */
  async submitProof(
    proof: Groth16Proof,
    publicSignals: string[],
    vkHash: string,
  ): Promise<{ jobId: string }> {
    const body = await fetchJson(
      `${this.baseUrl}/submit-proof/${this.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofType: "groth16",
          vkRegistered: true,
          proofOptions: PROOF_OPTIONS,
          proofData: { proof, publicSignals, vk: vkHash },
        }),
      },
    );
    const rec = body as Record<string, unknown>;
    if (rec.optimisticVerify !== "success") {
      throw new Error(
        `submit-proof optimisticVerify=${JSON.stringify(rec.optimisticVerify)} ` +
          `(expected "success"; body: ${JSON.stringify(body).slice(0, 500)})`,
      );
    }
    if (typeof rec.jobId !== "string" || !rec.jobId) {
      throw new Error(
        `submit-proof returned no jobId (body: ${JSON.stringify(body).slice(0, 500)})`,
      );
    }
    return { jobId: rec.jobId };
  }

  /** Poll one job until Finalized/Failed or the budget is exhausted. */
  async pollJob(
    jobId: string,
    budgetMs: number,
    overallDeadlineMs: number,
    intervalMs: number,
  ): Promise<{ status: JobStatus; txHash: string | null; finalized: boolean }> {
    const started = Date.now();
    let lastStatus: JobStatus = "Queued";
    let lastTxHash: string | null = null;
    while (true) {
      const now = Date.now();
      if (now - started >= budgetMs || now >= overallDeadlineMs) break;
      let body: unknown;
      try {
        body = await fetchJson(
          `${this.baseUrl}/job-status/${this.apiKey}/${jobId}`,
          { method: "GET" },
          10_000,
        );
      } catch (err) {
        // Transient poll error: keep polling while budget remains.
        console.error(`[kurier] job-status poll error: ${String(err)}`);
        await sleep(Math.min(intervalMs, 1000));
        continue;
      }
      const rec = body as Record<string, unknown>;
      if (typeof rec.status === "string") lastStatus = rec.status;
      if (typeof rec.txHash === "string" && rec.txHash) {
        lastTxHash = rec.txHash;
      }
      if (lastStatus === "Finalized") {
        return { status: lastStatus, txHash: lastTxHash, finalized: true };
      }
      if (lastStatus === "Failed") {
        return { status: lastStatus, txHash: lastTxHash, finalized: false };
      }
      await sleep(intervalMs);
    }
    return { status: lastStatus, txHash: lastTxHash, finalized: false };
  }

  /**
   * Full submission: register VK (once) -> submit -> poll within budget.
   * Never throws past the caller for a non-finalized outcome — returns
   * the observed status and lets the caller decide (fail-closed).
   * Throws only on register/submit hard failures.
   */
  async submitAndWait(
    vkJson: unknown,
    proof: Groth16Proof,
    publicSignals: string[],
    budgetMs: number,
    overallDeadlineMs: number,
    intervalMs: number,
  ): Promise<SubmitOutcome> {
    const vkHash = await this.registerVk(vkJson);
    const { jobId } = await this.submitProof(proof, publicSignals, vkHash);
    const polled = await this.pollJob(
      jobId,
      budgetMs,
      overallDeadlineMs,
      intervalMs,
    );
    return { jobId, ...polled };
  }
}

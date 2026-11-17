/**
 * Proof Gatekeeper HTTP service — plain Node http, no framework.
 *
 * Endpoints:
 *   GET  /health          -> { ok: true, ... } (no HMAC; platform health check)
 *   GET  /agent           -> same healthy JSON (RESEARCH.md §7.3)
 *   POST /agent           -> task + preflight handler (register THIS path)
 *   POST /                -> same handler (convenience alias)
 *
 * Request flow (fail-closed at every step; on ANY error / timeout /
 * uncertainty the answer is REJECT, never APPROVE by default):
 *   1. Capture the RAW body; verify x-agent-games-signature (HMAC-SHA256)
 *      BEFORE parsing JSON. Failure -> 401, no work.
 *   2. Parse JSON. Preflight (type == agent-games.preflight.v1) -> signed
 *      { ok: true, protocolVersion: "v1" }.
 *   3. Validate the envelope + timestamps (fail-closed REJECT).
 *   4. Idempotency: same task_id -> cached response (NOT proof reuse).
 *   5. Deterministic decision checklist (decision.ts).
 *   6. Generate a real Groth16 proof (decision 1 or 0) and verify it
 *      locally. PROOF_REUSED has no provable decision -> no proof.
 *   7. kurier mode only: submit to Kurier and poll toward Finalized
 *      within the remaining time budget.
 *   8. Sign the raw response body and return it.
 *
 * Hard deadline: 60 s per request (REQUEST_TIMEOUT_MS). On expiry the
 * server returns REJECT / "timeout" and abandons the in-flight work
 * (its late result is discarded, and proof_tx is NOT marked used, so a
 * platform retry of the same task_id can still be decided correctly).
 */
import * as http from "http";
import { loadConfig, secretKeys, type Config } from "./config";
import {
  signBody,
  verifySignatureMulti,
  SIGNATURE_HEADER,
} from "./hmac";
import { isPreflight, preflightResponse, TASK_TYPE } from "./preflight";
import {
  checkTimestamps,
  evaluateDecision,
  validateInput,
} from "./decision";
import {
  loadVerificationKey,
  prove,
  resolveCircuitDir,
  verifyArtifacts,
  verifyLocal,
} from "./prover";
import { KurierClient } from "./zkverify";
import { ProofStore } from "./store";
import {
  InvalidEnvelopeError,
  type GatekeeperResponse,
  type GatekeeperTask,
} from "./types";

const store = new ProofStore();

interface RequestState {
  settled: boolean;
  timedOut: boolean;
}

function sendSigned(
  res: http.ServerResponse,
  state: RequestState,
  secret: Buffer,
  status: number,
  bodyObj: unknown,
): void {
  if (state.settled) return;
  state.settled = true;
  const raw = Buffer.from(JSON.stringify(bodyObj), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: signBody(secret, raw),
  });
  res.end(raw);
}

function sendUnsignedError(
  res: http.ServerResponse,
  state: RequestState,
  status: number,
  message: string,
): void {
  // Only used before the secret is known to be usable (never in practice:
  // the server refuses to start without a secret). Kept for completeness.
  if (state.settled) return;
  state.settled = true;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/** Read the raw body with a size cap. */
function readRawBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new Error("body too large"));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function rejectResponse(
  reasonCode: GatekeeperResponse["reason_code"],
  proofTx: string,
): GatekeeperResponse {
  return { decision: "REJECT", reason_code: reasonCode, proof_tx: proofTx };
}

export function createServer(config: Config): http.Server {
  const keys = secretKeys(config.hmacSecretRaw);
  const circuitDir = resolveCircuitDir(config);
  verifyArtifacts(circuitDir);
  const vkJson = loadVerificationKey(circuitDir);
  const kurier =
    config.zkVerifyMode === "kurier"
      ? new KurierClient(config.kurierBaseUrl, config.kurierApiKey)
      : null;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, config, keys, circuitDir, vkJson, kurier);
  });
  return server;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
  keys: Buffer[],
  circuitDir: string,
  vkJson: unknown,
  kurier: KurierClient | null,
): Promise<void> {
  // Per-request signing key. Starts as the primary candidate (used for the
  // health check and pre-verification errors) and is replaced by whichever
  // candidate key matched the inbound signature, so responses are signed
  // with the same key encoding the platform used.
  let secret = keys[0];
  const state: RequestState = { settled: false, timedOut: false };
  const startedAt = Date.now();
  const deadlineMs = startedAt + config.requestTimeoutMs;

  // Hard per-request deadline. Fires once; the in-flight handler checks
  // `state.timedOut` before writing anything to the store or socket.
  const timer = setTimeout(() => {
    if (state.settled) return;
    state.timedOut = true;
    log("[timeout] request exceeded", config.requestTimeoutMs, "ms");
    sendSigned(res, state, secret, 200, {
      decision: "REJECT",
      reason_code: "TIMEOUT",
      proof_tx: "0x0000000000000000000000000000000000000000",
    });
  }, config.requestTimeoutMs);
  timer.unref?.();

  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // ---- Health checks (no HMAC on GET) -------------------------------
    if (req.method === "GET" && (path === "/health" || path === "/agent")) {
      clearTimeout(timer);
      sendSigned(res, state, secret, 200, {
        ok: true,
        service: "proof-gatekeeper",
        protocolVersion: "v1",
        mode: config.zkVerifyMode,
      });
      return;
    }

    if (req.method !== "POST" || (path !== "/agent" && path !== "/")) {
      clearTimeout(timer);
      sendSigned(res, state, secret, 404, { error: "not found" });
      return;
    }

    // ---- 1. Raw body + HMAC BEFORE parsing ---------------------------
    let raw: Buffer;
    try {
      raw = await readRawBody(req, config.maxBodyBytes);
    } catch {
      clearTimeout(timer);
      sendSigned(res, state, secret, 413, { error: "body too large" });
      return;
    }
    if (state.timedOut) return;
    const matchedKey = verifySignatureMulti(
      keys,
      raw,
      req.headers[SIGNATURE_HEADER],
    );
    if (!matchedKey) {
      clearTimeout(timer);
      sendSigned(res, state, secret, 401, { error: "invalid signature" });
      return;
    }
    secret = matchedKey;

    // ---- 2. Parse JSON ------------------------------------------------
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      clearTimeout(timer);
      sendSigned(res, state, secret, 400, {
        decision: "REJECT",
        reason_code: "INVALID_TASK",
        proof_tx: "0x0000000000000000000000000000000000000000",
      });
      return;
    }
    if (state.timedOut) return;

    // ---- Preflight (branch on type before touching task fields) -------
    if (isPreflight(body)) {
      clearTimeout(timer);
      sendSigned(res, state, secret, 200, preflightResponse());
      return;
    }

    // ---- 3. Envelope validation ---------------------------------------
    const task = body as Partial<GatekeeperTask>;
    try {
      if (task.type !== TASK_TYPE) {
        throw new InvalidEnvelopeError(
          `Unexpected type: ${JSON.stringify(task.type)}`,
        );
      }
      if (typeof task.task_id !== "string" || task.task_id === "") {
        throw new InvalidEnvelopeError("Missing task_id");
      }
      if (task.input === undefined) {
        throw new InvalidEnvelopeError("Missing input");
      }
      validateInput(task.input);
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      log("[invalid]", msg);
      sendSigned(res, state, secret, 400, {
        decision: "REJECT",
        reason_code: "INVALID_TASK",
        proof_tx: "0x0000000000000000000000000000000000000000",
      });
      return;
    }
    const fullTask = task as GatekeeperTask;
    const proofTxEcho: string = fullTask.input.proof_tx;

    // ---- 4. Idempotency: same task_id -> cached response --------------
    const cached = store.getCachedResponse(fullTask.task_id);
    if (cached) {
      clearTimeout(timer);
      log(`[${fullTask.task_id}] idempotent retry -> cached ${cached.decision}`);
      sendSigned(res, state, secret, 200, cached);
      return;
    }

    // ---- Timestamps (fail-closed, before any proving work) ------------
    const ts = checkTimestamps(
      fullTask.issued_at,
      fullTask.deadline_at,
      Date.now(),
      config.maxTaskAgeMs,
      config.clockSkewMs,
    );
    if (!ts.ok) {
      clearTimeout(timer);
      log(`[${fullTask.task_id}] stale timestamp: ${ts.reason}`);
      const response = rejectResponse("STALE_TIMESTAMP", proofTxEcho);
      store.cacheResponse(fullTask.task_id, response);
      sendSigned(res, state, secret, 200, response);
      return;
    }

    // ---- 5. Deterministic decision ------------------------------------
    const decision = evaluateDecision(
      fullTask.input,
      store.isProofReused(proofTxEcho),
    );
    log(
      `[${fullTask.task_id}] decision=${decision.decision} reason=${decision.reasonCode}`,
    );

    // PROOF_REUSED has no provable decision=0 (circuit input check) and
    // no proof to submit — return the REJECT without proof (RESEARCH §1.4).
    if (decision.reasonCode === "PROOF_REUSED") {
      clearTimeout(timer);
      const response = rejectResponse("PROOF_REUSED", proofTxEcho);
      store.cacheResponse(fullTask.task_id, response);
      sendSigned(res, state, secret, 200, response);
      return;
    }

    // ---- 6. Real Groth16 proof + local verification -------------------
    let proveResult;
    try {
      proveResult = await prove(
        fullTask,
        decision.decision === "APPROVE" ? 1 : 0,
        config,
        circuitDir,
        secret,
      );
    } catch (err) {
      clearTimeout(timer);
      log(`[${fullTask.task_id}] proving failed: ${String(err)}`);
      if (!state.timedOut) {
        const response = rejectResponse("PROVING_FAILED", proofTxEcho);
        store.cacheResponse(fullTask.task_id, response);
        sendSigned(res, state, secret, 200, response);
      }
      return;
    }
    if (state.timedOut) return;

    let verified = false;
    try {
      verified = await verifyLocal(
        proveResult.proof,
        proveResult.publicSignals,
        circuitDir,
      );
    } catch (err) {
      log(`[${fullTask.task_id}] local verify error: ${String(err)}`);
    }
    if (!verified) {
      clearTimeout(timer);
      log(`[${fullTask.task_id}] local verification FAILED`);
      if (!state.timedOut) {
        const response = rejectResponse("INTERNAL_ERROR", proofTxEcho);
        store.cacheResponse(fullTask.task_id, response);
        sendSigned(res, state, secret, 200, response);
      }
      return;
    }
    if (state.timedOut) return;

    // ---- 7. Kurier submission (kurier mode only) ----------------------
    let responseTx = proofTxEcho;
    let finalDecision = decision.decision;
    let finalReason: GatekeeperResponse["reason_code"] = decision.reasonCode;
    if (kurier) {
      const remainingMs = deadlineMs - Date.now();
      const budgetMs = Math.max(
        0,
        Math.min(config.kurierPollBudgetMs, remainingMs - 5_000),
      );
      try {
        const outcome = await kurier.submitAndWait(
          vkJson,
          proveResult.proof,
          proveResult.publicSignals,
          budgetMs,
          deadlineMs,
          config.kurierPollIntervalMs,
        );
        if (outcome.txHash) responseTx = outcome.txHash;
        log(
          `[${fullTask.task_id}] kurier job=${outcome.jobId} status=${outcome.status} tx=${outcome.txHash ?? "-"}`,
        );
        if (config.requireFinalized && !outcome.finalized) {
          // Checklist item (5): verification must reach Finalized before
          // approval. Fail closed — but still include the local proof so
          // the platform can verify it independently.
          finalDecision = "REJECT";
          finalReason = "NOT_FINALIZED";
        }
      } catch (err) {
        log(`[${fullTask.task_id}] kurier submission failed: ${String(err)}`);
        if (config.requireFinalized) {
          finalDecision = "REJECT";
          finalReason = "NOT_FINALIZED";
        }
        // If REQUIRE_FINALIZED=false, keep the local decision; the proof
        // is still included in the response.
      }
      if (state.timedOut) return;
    }

    // ---- 8. Respond (signed) ------------------------------------------
    const response: GatekeeperResponse = {
      decision: finalDecision,
      reason_code: finalReason,
      proof: proveResult.proof,
      public_signals: proveResult.publicSignals,
      proof_tx: responseTx,
    };
    if (!state.timedOut) {
      store.markProofUsed(proofTxEcho);
      store.cacheResponse(fullTask.task_id, response);
      clearTimeout(timer);
      log(
        `[${fullTask.task_id}] responded ${finalDecision}/${finalReason} in ${Date.now() - startedAt}ms`,
      );
      sendSigned(res, state, secret, 200, response);
    }
  } catch (err) {
    clearTimeout(timer);
    log("[internal]", String(err));
    if (!state.timedOut && !state.settled) {
      // Fail closed on any unexpected error. proof_tx is unknown here, so
      // use the zero address placeholder (documented off-path value).
      sendSigned(res, state, secret, 200, {
        decision: "REJECT",
        reason_code: "INTERNAL_ERROR",
        proof_tx: "0x0000000000000000000000000000000000000000",
      });
    }
  }
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  let server: http.Server;
  try {
    server = createServer(config);
  } catch (err) {
    console.error(
      `Fatal: failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  server.listen(config.port, () => {
    log(
      `proof-gatekeeper listening on :${config.port} ` +
        `(mode=${config.zkVerifyMode}, requireFinalized=${config.requireFinalized}, ` +
        `taskIdHash=${config.taskIdHash}, timeout=${config.requestTimeoutMs}ms)`,
    );
  });
  server.on("error", (err) => {
    console.error(`Fatal: server error: ${String(err)}`);
    process.exit(1);
  });
  // Graceful shutdown. Explicit process.exit is required: snarkjs leaves
  // worker threads alive after a fullProve, so the process would otherwise
  // ignore a plain close() and linger (relevant for Docker/Railway stops).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  main();
}

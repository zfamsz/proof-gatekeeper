/**
 * Local test harness — starts the real server as a child process and
 * replays sample envelopes against it over HTTP with real HMAC signing.
 *
 * What it proves (not mocks):
 *  - a REAL Groth16 proof is produced by snarkjs and verifies locally
 *    against circuits/gatekeeper.vkey.json (groth16.verify === true);
 *  - public_signals[0] == Poseidon(salt, taskId) with the salt derived
 *    exactly as the server derives it (HMAC(secret, "gatekeeper-salt:"+id));
 *  - the full decision checklist, idempotency, HMAC rejection, stale
 *    timestamps, proof reuse, and the 60 s timeout path.
 *
 * Run:  npm run build && npm test
 * Uses a throwaway HMAC secret generated for this run only — never
 * committed, never logged. ZKVERIFY_MODE=local: nothing touches Kurier
 * or mainnet. The timeout case spawns a second server with
 * REQUEST_TIMEOUT_MS=1 so the timer path fires deterministically.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import * as snarkjs from "snarkjs";
import {
  deriveSalt,
  REGISTERED_VK_HASH_MOD_P,
  secretBytes,
  taskIdToField,
} from "../src/config";
import { poseidonCommitment, resolveCircuitDir, loadVerificationKey } from "../src/prover";
import { signBody, verifySignature, SIGNATURE_HEADER } from "../src/hmac";
import type { GatekeeperResponse, GatekeeperTask } from "../src/types";

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const SAMPLES_DIR = path.join(PROJECT_ROOT, "test", "samples");
const SECRET_HEX = crypto.randomBytes(32).toString("hex"); // test-only
const SECRET = secretBytes(SECRET_HEX);
const PORT = 31_101;
const TIMEOUT_PORT = 31_102;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function loadSample(name: string): GatekeeperTask {
  const task = JSON.parse(
    fs.readFileSync(path.join(SAMPLES_DIR, name), "utf8"),
  ) as GatekeeperTask;
  // Fresh timestamps: the samples ship with fixed ones, and the server
  // fail-closes on stale/unparseable timestamps.
  const now = Date.now();
  task.issued_at = new Date(now - 60_000).toISOString();
  task.deadline_at = new Date(now + 3_600_000).toISOString();
  return task;
}

interface HttpResult {
  status: number;
  raw: Buffer;
  json: Record<string, unknown> | null;
  signatureValid: boolean;
}

async function post(
  port: number,
  bodyObj: unknown,
  opts: { secret?: Buffer; sign?: boolean; rawHeader?: string } = {},
): Promise<HttpResult> {
  const raw = Buffer.from(JSON.stringify(bodyObj), "utf8");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sign !== false) {
    headers[SIGNATURE_HEADER] =
      opts.rawHeader ?? signBody(opts.secret ?? SECRET, raw);
  }
  const res = await fetch(`http://127.0.0.1:${port}/agent`, {
    method: "POST",
    headers,
    body: raw,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {
    json = null;
  }
  return {
    status: res.status,
    raw: buf,
    json,
    signatureValid: verifySignature(
      opts.secret ?? SECRET,
      buf,
      res.headers.get(SIGNATURE_HEADER) ?? undefined,
    ),
  };
}

async function getHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const json = (await res.json()) as { ok?: boolean };
    return res.status === 200 && json.ok === true;
  } catch {
    return false;
  }
}

function startServer(port: number, extraEnv: Record<string, string>): ChildProcess {
  const child = spawn("node", [path.join(PROJECT_ROOT, "dist", "src", "server.js")], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      AGENT_GAMES_HMAC_SECRET: SECRET_HEX,
      ZKVERIFY_MODE: "local",
      REQUIRE_FINALIZED: "true",
      TASK_ID_HASH: "sha256",
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[srv:${port}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stdout.write(`[srv:${port}:err] ${d}`));
  return child;
}

async function waitHealthy(port: number, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await getHealth(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 5_000).unref();
  });
}

async function assertProofVerifies(
  name: string,
  resp: GatekeeperResponse,
  task: GatekeeperTask,
  expectedDecision: "0" | "1",
): Promise<void> {
  const circuitDir = resolveCircuitDir();
  const vk = loadVerificationKey(circuitDir);
  const proof = resp.proof;
  const signals = resp.public_signals;
  check(`${name}: proof present`, !!proof);
  check(`${name}: 13 public signals`, Array.isArray(signals) && signals.length === 13);
  if (!proof || !signals || signals.length !== 13) return;
  const ok = await snarkjs.groth16.verify(vk, signals, proof);
  check(`${name}: groth16.verify == true (REAL proof)`, ok === true);
  // Signal layout (RESEARCH.md §5).
  const taskIdField = taskIdToField(task.task_id, "sha256");
  const salt = deriveSalt(task.task_id, SECRET, "hmac");
  const commitment = await poseidonCommitment(salt, taskIdField);
  check(`${name}: signals[0] == Poseidon(salt, taskId)`, signals[0] === commitment);
  check(`${name}: signals[1] == registered vkHash mod p`, signals[1] === REGISTERED_VK_HASH_MOD_P);
  check(`${name}: signals[12] == taskId field`, signals[12] === taskIdField.toString());
  check(`${name}: signals[11] == decision (${expectedDecision})`, signals[11] === expectedDecision);
  check(`${name}: signals[3..10] match envelope inputs`, signals[3] === task.input.minimum &&
    signals[4] === task.input.public_balance &&
    signals[5] === String(task.input.expiry_block) &&
    signals[6] === String(task.input.current_block) &&
    signals[9] === task.input.amount &&
    signals[10] === task.input.max_transfer);
}

async function main(): Promise<void> {
  console.log("== Proof Gatekeeper harness ==");
  console.log(`   mode=local, taskIdHash=sha256, test secret: <random 32B, not logged>`);

  const server = startServer(PORT, {});
  try {
    check("server starts and /health returns {ok:true}", await waitHealthy(PORT));

    // --- 1. Preflight -------------------------------------------------
    console.log("-- preflight --");
    const pre = await post(PORT, { type: "agent-games.preflight.v1" });
    check("preflight: HTTP 200", pre.status === 200, `got ${pre.status}`);
    check("preflight: {ok:true, protocolVersion:v1}", pre.json?.ok === true && pre.json?.protocolVersion === "v1");
    check("preflight: response signature valid", pre.signatureValid);

    // Bad-signature preflight must 401.
    const preBad = await post(PORT, { type: "agent-games.preflight.v1" }, { rawHeader: "deadbeef" });
    check("preflight with bad signature: HTTP 401", preBad.status === 401, `got ${preBad.status}`);

    // --- 2. Valid APPROVE ----------------------------------------------
    console.log("-- valid APPROVE --");
    const valid = loadSample("valid.json");
    const t0 = Date.now();
    const approve = await post(PORT, valid);
    const approveMs = Date.now() - t0;
    console.log(`   approve round-trip: ${approveMs} ms`);
    check("approve: HTTP 200", approve.status === 200, `got ${approve.status}`);
    check("approve: response signature valid", approve.signatureValid);
    const approveBody = approve.json as unknown as GatekeeperResponse;
    check("approve: decision APPROVE", approveBody?.decision === "APPROVE");
    check("approve: reason VALID_CONDITION", approveBody?.reason_code === "VALID_CONDITION");
    check("approve: proof_tx echoes envelope", approveBody?.proof_tx === valid.input.proof_tx);
    await assertProofVerifies("approve", approveBody, valid, "1");

    // --- 3. Same task_id retry (idempotency, NOT reuse) ----------------
    console.log("-- idempotent retry --");
    const retry = await post(PORT, valid);
    const retryBody = retry.json as unknown as GatekeeperResponse;
    check("retry same task_id: HTTP 200", retry.status === 200);
    check("retry same task_id: still APPROVE (not PROOF_REUSED)", retryBody?.decision === "APPROVE" && retryBody?.reason_code === "VALID_CONDITION");
    check("retry same task_id: identical public_signals", JSON.stringify(retryBody?.public_signals) === JSON.stringify(approveBody?.public_signals));

    // --- 4. Trap REJECTs (each must carry a REAL verifying proof) ------
    const traps: Array<[string, string, string]> = [
      ["trap-threshold.json", "THRESHOLD_MISMATCH", "threshold"],
      ["trap-vk.json", "VK_SUBSTITUTION", "vk"],
      ["trap-expired.json", "EXPIRED_CONDITION", "expired"],
      ["trap-recipient.json", "RECIPIENT_MISMATCH", "recipient"],
      ["trap-amount.json", "AMOUNT_OVERFLOW", "amount"],
    ];
    for (const [file, reason, label] of traps) {
      console.log(`-- trap: ${label} --`);
      const task = loadSample(file);
      const res = await post(PORT, task);
      const body = res.json as unknown as GatekeeperResponse;
      check(`${label}: HTTP 200`, res.status === 200, `got ${res.status}`);
      check(`${label}: decision REJECT`, body?.decision === "REJECT");
      check(`${label}: reason ${reason}`, body?.reason_code === reason, `got ${body?.reason_code}`);
      check(`${label}: response signature valid`, res.signatureValid);
      await assertProofVerifies(label, body, task, "0");
    }

    // --- 5. Bad HMAC / missing signature -------------------------------
    console.log("-- bad HMAC --");
    const badHmac = await post(PORT, loadSample("valid.json"), { rawHeader: "00".repeat(32) });
    check("bad HMAC: HTTP 401", badHmac.status === 401, `got ${badHmac.status}`);
    const noSig = await post(PORT, loadSample("valid.json"), { sign: false });
    check("missing signature: HTTP 401", noSig.status === 401, `got ${noSig.status}`);

    // --- 6. Stale timestamp --------------------------------------------
    console.log("-- stale timestamp --");
    const stale = loadSample("valid.json");
    stale.task_id = "gk_test_stale_001";
    stale.input.proof_tx = "0xa4c1000000000000000000000000000000000000000000000000000000008ff9";
    stale.issued_at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    stale.deadline_at = new Date(Date.now() - 3_600_000).toISOString();
    const staleRes = await post(PORT, stale);
    const staleBody = staleRes.json as unknown as GatekeeperResponse;
    check("stale: HTTP 200", staleRes.status === 200, `got ${staleRes.status}`);
    check("stale: decision REJECT", staleBody?.decision === "REJECT");
    check("stale: reason STALE_TIMESTAMP", staleBody?.reason_code === "STALE_TIMESTAMP", `got ${staleBody?.reason_code}`);
    check("stale: no proof (off-path failure)", staleBody?.proof === undefined);

    // --- 7. Replayed proof_tx under a different task_id ----------------
    console.log("-- proof reuse --");
    const reused = loadSample("reused.json"); // same proof_tx as valid.json
    const reusedRes = await post(PORT, reused);
    const reusedBody = reusedRes.json as unknown as GatekeeperResponse;
    check("reused: HTTP 200", reusedRes.status === 200, `got ${reusedRes.status}`);
    check("reused: decision REJECT", reusedBody?.decision === "REJECT");
    check("reused: reason PROOF_REUSED", reusedBody?.reason_code === "PROOF_REUSED", `got ${reusedBody?.reason_code}`);
    check("reused: no proof (unprovable decision=0 on valid inputs)", reusedBody?.proof === undefined);
  } finally {
    await stopServer(server);
  }

  // --- 8. Timeout path (separate server, 1 ms deadline) ---------------
  console.log("-- timeout (REQUEST_TIMEOUT_MS=1) --");
  const timeoutServer = startServer(TIMEOUT_PORT, { REQUEST_TIMEOUT_MS: "1" });
  try {
    check("timeout server starts", await waitHealthy(TIMEOUT_PORT));
    const task = loadSample("valid.json");
    task.task_id = "gk_test_timeout_001";
    const res = await post(TIMEOUT_PORT, task);
    const body = res.json as unknown as GatekeeperResponse;
    check("timeout: HTTP 200", res.status === 200, `got ${res.status}`);
    check("timeout: decision REJECT", body?.decision === "REJECT");
    check("timeout: reason TIMEOUT", body?.reason_code === "TIMEOUT", `got ${body?.reason_code}`);
  } finally {
    await stopServer(timeoutServer);
  }

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`);
  if (failed > 0) {
    console.log("Failed checks:", failures.join(", "));
  }
  // Explicit exit: snarkjs leaves worker threads alive after fullProve,
  // so a process that proved anything never exits on its own. (The
  // production server is long-running, so this only matters here.)
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("HARNESS FATAL:", err);
  process.exit(1);
});

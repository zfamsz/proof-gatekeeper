/**
 * Groth16 prover (snarkjs) for the GatekeeperEvaluation circuit.
 *
 * Circuit inputs (13, RESEARCH.md §5) and public-signal order (verified
 * empirically this session — see RESEARCH.md §5 and the harness):
 *   signals = [Poseidon(salt, taskId), registeredVkHash, proofVkHash,
 *              minimum, publicBalance, expiryBlock, currentBlock,
 *              recipient, conditionRecipient, amount, maxTransfer,
 *              decision, taskId]
 * with salt FIRST in the Poseidon commitment and taskId LAST in the
 * signals. (An earlier scratch probe used Poseidon([taskId, salt]); that
 * order does NOT match signal[0] — RESEARCH.md §5 documents the
 * correction, and the harness asserts the salt-first commitment.)
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import {
  EXPECTED_ARTIFACTS,
  deriveSalt,
  secretBytes,
  taskIdToField,
  toField,
  type Config,
} from "./config";
import type { GatekeeperTask, Groth16Proof } from "./types";

export interface ProveResult {
  proof: Groth16Proof;
  publicSignals: string[];
  /** Salt used (decimal string), for the harness / debugging — never secret. */
  salt: string;
  /** taskId as a field element (decimal string). */
  taskIdField: string;
}

let poseidonInstance: Awaited<ReturnType<typeof buildPoseidon>> | null = null;

async function getPoseidon() {
  if (!poseidonInstance) poseidonInstance = await buildPoseidon();
  return poseidonInstance;
}

/** Poseidon(salt, taskId) — the public commitment, signal[0]. */
export async function poseidonCommitment(
  salt: bigint,
  taskIdField: bigint,
): Promise<string> {
  const poseidon = await getPoseidon();
  return poseidon.F.toString(poseidon([salt, taskIdField]));
}

export function resolveCircuitDir(config?: Config): string {
  const candidates: string[] = [];
  if (config?.circuitDir) candidates.push(config.circuitDir);
  if (process.env.CIRCUIT_DIR) candidates.push(process.env.CIRCUIT_DIR);
  candidates.push(path.join(__dirname, "..", "..", "circuits"));
  candidates.push(path.join(__dirname, "..", "circuits"));
  candidates.push(path.join(process.cwd(), "circuits"));
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, EXPECTED_ARTIFACTS.wasm.file)) &&
      fs.existsSync(path.join(dir, EXPECTED_ARTIFACTS.zkey.file))
    ) {
      return dir;
    }
  }
  throw new Error(
    `Circuit artifacts not found. Checked: ${candidates.join(", ")}. ` +
      `Set CIRCUIT_DIR or run the Docker build (it downloads them).`,
  );
}

/** Fail-closed artifact check: size + SHA-256 against RESEARCH.md §4. */
export function verifyArtifacts(dir: string): void {
  for (const key of ["wasm", "zkey", "vkey"] as const) {
    const spec = EXPECTED_ARTIFACTS[key];
    const file = path.join(dir, spec.file);
    if (!fs.existsSync(file)) {
      throw new Error(`Missing circuit artifact: ${file}`);
    }
    const buf = fs.readFileSync(file);
    if (buf.length !== spec.size) {
      throw new Error(
        `${spec.file}: size ${buf.length} != expected ${spec.size}`,
      );
    }
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (hash !== spec.sha256) {
      throw new Error(
        `${spec.file}: SHA-256 ${hash} != expected ${spec.sha256}`,
      );
    }
  }
}

export function loadVerificationKey(dir: string): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.join(dir, EXPECTED_ARTIFACTS.vkey.file),
      "utf8",
    ),
  );
}

/**
 * Build the 13 circuit inputs for a task + decision.
 * All values are field elements rendered as decimal strings.
 */
export function buildCircuitInput(
  task: GatekeeperTask,
  decision: 0 | 1,
  config: Config,
  // Key that matched the inbound signature, when the caller verified one.
  // Defaults to the primary key (secretBytes) so direct callers are
  // unaffected; the server passes the matched key so the salt derivation
  // uses the same key encoding the platform signed with.
  secretOverride?: Buffer,
): { input: Record<string, string>; salt: bigint; taskIdField: bigint } {
  const secret = secretOverride ?? secretBytes(config.hmacSecretRaw);
  const salt = deriveSalt(task.task_id, secret, config.saltDerivation);
  const taskIdField = taskIdToField(task.task_id, config.taskIdHash);
  const inp = task.input;
  const input: Record<string, string> = {
    taskId: taskIdField.toString(),
    registeredVkHash: toField(inp.registered_vk).toString(),
    proofVkHash: toField(inp.proof_vk).toString(),
    minimum: toField(inp.minimum).toString(),
    publicBalance: toField(inp.public_balance).toString(),
    expiryBlock: toField(inp.expiry_block).toString(),
    currentBlock: toField(inp.current_block).toString(),
    recipient: toField(inp.recipient).toString(),
    conditionRecipient: toField(inp.condition_recipient).toString(),
    amount: toField(inp.amount).toString(),
    maxTransfer: toField(inp.max_transfer).toString(),
    decision: decision.toString(),
    salt: salt.toString(),
  };
  return { input, salt, taskIdField };
}

/** Generate a real Groth16 proof with snarkjs (witness + prove). */
export async function prove(
  task: GatekeeperTask,
  decision: 0 | 1,
  config: Config,
  circuitDir: string,
  secretOverride?: Buffer,
): Promise<ProveResult> {
  const { input, salt, taskIdField } = buildCircuitInput(
    task,
    decision,
    config,
    secretOverride,
  );
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    path.join(circuitDir, EXPECTED_ARTIFACTS.wasm.file),
    path.join(circuitDir, EXPECTED_ARTIFACTS.zkey.file),
  );
  return {
    proof: proof as Groth16Proof,
    publicSignals,
    salt: salt.toString(),
    taskIdField: taskIdField.toString(),
  };
}

/** Verify a proof locally against the exported VK. */
export async function verifyLocal(
  proof: Groth16Proof,
  publicSignals: string[],
  circuitDir: string,
): Promise<boolean> {
  const vk = loadVerificationKey(circuitDir);
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

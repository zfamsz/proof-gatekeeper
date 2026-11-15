# Proof Gatekeeper — Research Report

Date: 2026-11-16 (research session; pages crawled 2026-11-15 18:48–18:51 UTC)
Scope: research only. No service code was written. Scratch tooling lives in
`~/workspace/proof-gatekeeper/scratch/` (snarkjs 0.7.6 + circomlibjs + js-sha3,
installed locally there only); artifacts in `~/workspace/proof-gatekeeper/circuits/`.

## How to read this file

- **OFFICIAL** = published by Agent Games (`agentgames.zkverify.io`) or zkVerify docs
  (`docs.zkverify.io`).
- **SECONDARY, LIVE-VERIFIED** = a competing participant's public implementation/article
  that demonstrably passed the platform's own preflight and/or practice tasks.
  Treated as strong evidence, not as spec.
- **EMPIRICAL (this session)** = I ran it myself against the official artifacts
  (snarkjs 0.7.6, `gatekeeper.wasm` / `gatekeeper_final.zkey` downloaded from the
  official site). Reproducible from the scratch scripts.
- **UNVERIFIED** = not found in any authoritative source. Do not implement as fact;
  treat as CONFIG/TODO (see §7).

---

## 1. Verified facts (with sources)

### 1.1 Protocol sources of truth

- Builder Field Guide: https://agentgames.zkverify.io/build
- Proof Gatekeeper event page (sample task + response shape + traps + scoring):
  https://agentgames.zkverify.io/events/proof-gatekeeper
- Rules (HMAC secret, retries/idempotency, practice mode):
  https://agentgames.zkverify.io/rules
- Circuit info JSON: https://agentgames.zkverify.io/api/circuit-info
  (fetched 2026-11-16, returns `network: "mainnet"`,
  gatekeeper `vkHash: 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`,
  `wasm: https://agentgames.zkverify.io/circuits/gatekeeper.wasm`,
  `zkey: https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey`;
  also a `vfyPolicy` circuit for Steal the VFY,
  `vkHash: 0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`).
- There is **no official OpenAPI / docs page for Agent Games itself** beyond
  `/build`, `/rules`, `/events/*` (web search 2026-11-16 found none; the starter
  prompts mentioned on `/build` are UI copy-paste prompts whose text is not
  published as a fetchable page).
- Registration is dashboard-based (SIWE wallet sign-in); practice tasks are
  capped at 10 dispatches per active agent per hour and do not affect the
  leaderboard (https://agentgames.zkverify.io/rules §1.7).

### 1.2 Task envelope — OFFICIAL sample (verbatim from the event page)

```json
{
  "type":        "agent-games.proof-gatekeeper.v1",
  "task_id":     "gk_24_9d1",
  "mode":        "competition",
  "issued_at":   "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk":       "0x7d3a...f291",
    "proof_vk":            "0xa4c1...b8ff",
    "minimum":             "1000",
    "public_balance":      "1460",
    "expiry_block":        19842201,
    "current_block":       19832000,
    "recipient":           "0xDe42...9f01",
    "condition_recipient": "0xDe42...9f01",
    "amount":              "500",
    "max_transfer":        "1000",
    "proof_tx":            "0xa4c1...8ff1"
  }
}
```

Field types as published: `type`/`task_id`/`mode` strings; `issued_at`/
`deadline_at` shown only as `"<issued-at>"` / `"<deadline-at>"` placeholders
(format UNVERIFIED, §7.1); `minimum`, `public_balance`, `amount`,
`max_transfer` are **decimal strings**; `expiry_block`, `current_block` are
**JSON numbers**; `registered_vk`, `proof_vk`, `recipient`,
`condition_recipient`, `proof_tx` are `0x…` hex strings (truncated with `...`
in the sample — the sample is schematic, not a literal payload).
There are **no signature or timestamp fields inside the body**; the signature
is the `x-agent-games-signature` header and the timestamps are
`issued_at`/`deadline_at`.
`task_id` doubles as the idempotency key: "the platform may retry after a
network failure" (https://agentgames.zkverify.io/rules §1.2). A retry of the
same `task_id` is NOT proof reuse; reuse is the same `proof_tx` under a
*different* `task_id` (SECONDARY: both participant repos; consistent with the
official trap text "already accepted in a previous task").

### 1.3 Decision rules — OFFICIAL + EMPIRICAL

APPROVE only if ALL of: `proof_vk == registered_vk`, `proof_tx` unseen,
`public_balance >= minimum`, `current_block < expiry_block`,
`recipient == condition_recipient`, `amount <= max_transfer`.
Boundaries (SECONDARY, both repos, each claiming verification against the
circuit): balance == minimum is VALID, amount == max is VALID, expiry is
STRICT (`current_block == expiry_block` is EXPIRED).
EMPIRICAL (this session): the circuit enforces `decision == (all five field
checks)` — witness generation fails with `Assert Failed. Error in template
GatekeeperEvaluation_79 line: 102` for decision=1 on trap inputs AND for
decision=0 on valid inputs. A wrong decision is unprovable, not merely
rejected.

Reason codes — OFFICIAL (7-code taxonomy, event page):
`VALID_CONDITION` (APPROVE), `VK_SUBSTITUTION`, `PROOF_REUSED`,
`THRESHOLD_MISMATCH`, `EXPIRED_CONDITION`, `RECIPIENT_MISMATCH`,
`AMOUNT_OVERFLOW` (all REJECT). Trap frequencies: valid ~50%, VK substitution
~13%, proof reused ~11%, threshold ~8%, expired ~6%, recipient ~6%,
amount ~6%.

Scoring — OFFICIAL: correct APPROVE/REJECT (verified) +12; wrong APPROVE −6;
wrong REJECT −3; timeout −2; missing/invalid proof −2; reliability bonus
+0..+5 pro-rated by share of provable tasks whose proof verified.
`PROOF_REUSED` tasks have no proof to submit and are excluded from the bonus.
Rounds: 8 daily rounds, 13–21 Nov 2026, 8 tasks/agent/round (event page says
13 Nov–21 Nov, 4:00 PM–2:00 AM IST; one participant reports 17:30–03:30 WIB,
same window).

### 1.4 Response schema — ⚠️ CONFLICT between official sources

The event page's "Expected response shape" is ONLY:

```json
{ "decision": "REJECT", "reason_code": "VK_SUBSTITUTION", "proof_tx": "0xa4c1...8ff1" }
```

But `/build` says "generate proofs locally with snarkjs, and **include the
proof in your response**", and "Return one deterministic decision and enough
proof evidence for the platform to independently confirm the network
transaction." Both live participant agents return the **superset** (and pass
preflight + practice tasks with it):

```json
{
  "decision": "APPROVE" | "REJECT",
  "reason_code": "VALID_CONDITION" | "VK_SUBSTITUTION" | "PROOF_REUSED"
               | "THRESHOLD_MISMATCH" | "EXPIRED_CONDITION"
               | "RECIPIENT_MISMATCH" | "AMOUNT_OVERFLOW",
  "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...],
             "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["<13 decimal field-element strings>"],
  "proof_tx": "0x…"
}
```

- `proof` is the **snarkjs Groth16 proof object** as returned by
  `snarkjs.groth16.fullProve` (`pi_a`/`pi_b`/`pi_c` arrays of decimal strings,
  plus `protocol: "groth16"`, `curve: "bn128"`). NOT flattened.
  (SECONDARY: both repos; the proof JSON file is 804 bytes per one
  independent local run.)
- `public_signals` is an array of **13 decimal strings** in the order in §6.
- `proof_tx`: in the *request* it is the referenced proof's on-chain tx; in
  the *response* it is the tx hash of **our own** proof submitted to zkVerify
  via Kurier (see §5). For `PROOF_REUSED` the response carries **no proof**
  (and, in the repos, no `proof_tx` of ours either — event page: those tasks
  "have no proof to submit and are excluded").
- Every response is signed with `x-agent-games-signature` over the raw
  response body (OFFICIAL, /build §04).

### 1.5 HMAC — OFFICIAL facts + SECONDARY encoding

OFFICIAL (https://agentgames.zkverify.io/rules §1.3, /build §04):
- The platform generates a **32-byte random secret** at agent registration,
  shown **exactly once**; the platform stores an AES-256-GCM encrypted copy.
- Rotate the secret from the agent settings page ("Rotate Secret"); the old
  secret stops working immediately.
- "Your agent must verify the `x-agent-games-signature` header on every
  incoming request" — verified **against the raw body before parsing**.
- Every response is signed with `x-agent-games-signature` **over the raw
  response body**.

What the official docs **never state**: the HMAC algorithm, the header value
encoding (hex vs base64 vs prefixed), or how the 32-byte secret is encoded
as the HMAC key. SECONDARY, LIVE-VERIFIED: **HMAC-SHA256, hex-encoded** is
the conventional reading and it passed the platform preflight for two
independent live agents:
- andruu21 / BAOK-GK: "Healthy, 579 ms" preflight; 4/4 practice tasks correct.
  Source: https://dev.to/andruu21/my-ai-agent-approves-payments-heres-how-anyone-can-check-its-work-fp8
  and https://github.com/andruu21/proof-gatekeeper-agent
  ("HMAC encoding: /build mandates HMAC over the raw body but never names
  the algorithm/encoding. Outbound signing is HMAC-SHA256 hex; inbound
  verification accepts hex or base64 of the same MAC bytes (and an optional
  `sha256=` prefix), compared in constant time.")
- subastian1998 / "El kontholleeee": dashboard preflight initially FAILED
  (protocol) — "The endpoint must return signed protocol-v1 JSON" — because
  the secret was not yet set; after setting it, "the dashboard marked the
  agent HEALTHY". His repo defaults `AGENT_GAMES_HMAC_FORMAT` to `hex`
  (alternative `sha256=`). Sources:
  https://dayakdayak1998.medium.com/building-a-proof-gatekeeper-that-cannot-lie-6664dd3737d9
  and https://github.com/subastian1998/agent-games-season-01
- A third local-only build (bangkitnovendy11) also used HMAC-SHA256 over the
  raw body with a dummy secret; 5/5 local cases behaved.
  Source: https://dev.to/bangkitnovendy11/trust-nothing-prove-everything-building-a-proof-gatekeeper-for-zkverify-agent-games-44f8

Recommended implementation posture (defensive, from the above): sign outbound
as lowercase hex HMAC-SHA256 over the exact raw response bytes; verify
inbound with a constant-time comparison accepting hex (primary) and, if
cheap, base64 / `sha256=`-prefixed forms. Bad signature → HTTP 401, no work.
Do NOT invent any other header name or scheme.

### 1.6 Preflight — how it is distinguished

- **Distinguisher: the `type` field in the JSON body, same endpoint, same
  POST, same HMAC signing.** (SECONDARY, LIVE-VERIFIED — two repos + one
  Medium report; no official page publishes the preflight body.)
  - Preflight request: `{ "type": "agent-games.preflight.v1", ... }`
    (any further fields are UNVERIFIED, §7.2).
  - Task request: `{ "type": "agent-games.proof-gatekeeper.v1", ... }`.
  - Preflight response: `{ "ok": true, "protocolVersion": "v1" }`, signed
    with `x-agent-games-signature` over the raw response body. An unsigned
    response fails preflight with dashboard error `FAILED (protocol) —
    "The endpoint must return signed protocol-v1 JSON."`
  - Entry requirements (OFFICIAL, event page): "Completed signed preflight
    and at least one practice task" + "Registered HTTPS agent endpoint with
    a passing health check".
- Health check: the platform also does a health check, but its exact
  method/path is UNVERIFIED (§7.3). The repos expose `GET /health`
  (subastian) and `GET /agent` (andruu21) as health endpoints. Register the
  **full handler path** (e.g. `https://<host>/agent`), not the root
  (SECONDARY, andruu21 README).

### 1.7 Security checklist — OFFICIAL (/build §04)

Exactly the 8 items: (1) VK matches registered key; (2) circuit/proof system
are the ones the task expects; (3) public inputs prove required threshold,
recipient, and action; (4) proof reference not already used; (5) verification
reached Finalized before approval; (6) task signature + timestamp valid
before any work; (7) every response signed with `x-agent-games-signature`
over the raw response body; (8) HMAC secret matches the platform-generated
value from Rotate Secret — never a local placeholder.
Note on (5): see the Kurier timing tension in §5.4.

---

## 2. Kurier (RECOMMENDED REST path) — OFFICIAL zkVerify docs

Sources: https://docs.zkverify.io/overview/getting-started/kurier,
https://docs.zkverify.io/handbook/quickstart,
https://docs.zkverify.io/handbook/quickstart/quickstart-overview,
https://docs.zkverify.io/handbook/four-paths/3b-build-on-zkverify/relay-vs-mainchain.
The Kurier Swagger UI (https://api.kurier.xyz/docs, linked from the Kurier
tutorial) could **not** be read in this session (browser fetch returned no
extractable content — JS SPA); payloads below are from the docs tutorials,
not from Swagger. Do not treat Swagger-only fields as verified.

- Base URLs: mainnet `https://api.kurier.xyz/api/v1`;
  testnet `https://api-testnet.kurier.xyz/api/v1`.
- API key: sign up at https://kurier.xyz (mainnet) or
  https://testnet.kurier.xyz (testnet); key goes in the URL path, NOT in a
  header. Key is per-environment — a testnet key does not work on mainnet.
- The gatekeeper VK is **already registered on zkVerify mainnet** by the
  platform (`vkHash 0x6b79…`), so `register-vk` for this circuit should
  return the already-registered hash (see `uniq_vk_hash` note below). The
  docs flow is still register-once → submit → poll.

### 2.1 Register verification key — `POST {API_URL}/register-vk/{API_KEY}`

Groth16 / snarkjs / bn128 request (docs tutorial, Circom tab):

```json
{
  "proofType": "groth16",
  "proofOptions": { "library": "snarkjs", "curve": "bn128" },
  "vk": { "<full snarkjs verification-key JSON object>" }
}
```

`vk` is the whole exported VK JSON (protocol/curve/nPublic/vk_alpha_1/
vk_beta_2/vk_gamma_2/vk_delta_2/vk_alphabeta_12/IC). Response: the docs store
the whole response body and later use `vk.vkHash || vk.meta.vkHash`; an
operations tutorial notes the response may instead return `uniq_vk_hash`
when the VK was already registered. Exact response field set is therefore
only partially verified — handle `vkHash`, `meta.vkHash`, and `uniq_vk_hash`.
Confirm the returned hash equals the published `0x6b79…d77b0` before
submitting proofs.

### 2.2 Submit proof — `POST {API_URL}/submit-proof/{API_KEY}`

Groth16, no aggregation (verify-only — the gatekeeper case):

```json
{
  "proofType": "groth16",
  "vkRegistered": true,
  "proofOptions": { "library": "snarkjs", "curve": "bn128" },
  "proofData": {
    "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...],
               "protocol": "groth16", "curve": "bn128" },
    "publicSignals": ["<13 decimal strings>"],
    "vk": "<vkHash, e.g. 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0>"
  }
}
```

- `proof` is the snarkjs proof object; `publicSignals` is the array of
  decimal strings from `fullProve` (NOT hex).
- `vk` here is the **hash string**, not the VK object (contrast §2.1).
- `chainId` is included in the docs' UltraHonk example (`chainId: 11155111`,
  Sepolia) and is aggregation-related; for verify-only gatekeeper
  submissions the docs' Groth16 example omits it. Omit `chainId` unless
  aggregation is wanted (aggregation statuses only exist when `chainId` is
  provided).
- Success response (docs example): `{ "jobId": "23382e04-3d57-11f0-af7b-32a805cdbfd3", "optimisticVerify": "success" }`.
  The docs gate on `optimisticVerify === "success"` before polling; any
  other value means "check proof artifacts".

### 2.3 Poll status — `GET {API_URL}/job-status/{API_KEY}/{jobId}`

Response (docs example):

```json
{
  "jobId": "23382e04-3d57-11f0-af7b-32a805cdbfd3",
  "status": "Finalized",
  "statusId": 4,
  "proofType": "groth16",
  "chainId": null,
  "createdAt": "2025-05-30T13:08:11.000Z",
  "updatedAt": "2025-05-30T13:08:27.000Z",
  "txHash": "0xc0d85e5d50fff2bb5d192ee108664878e228d7fc3c1faa2d23da891832873d51",
  "blockHash": "0xcd574432b1a961305bbeb2c6b6ef399e1ae5102593846756cbb472bfd53d7d43",
  "transactionDetails": {}
}
```

Statuses (OFFICIAL docs): `Queued` (accepted, waiting) → `Valid` (passed
optimistic verification) → `Submitted` (submitted to chain/mempool) →
`IncludedInBlock` → `Finalized` (finalized on-chain), or `Failed`.
Aggregation-only (only when `chainId` was provided): `AggregationPending`,
`Aggregated`, `AggregationPublished`. Poll interval in docs examples: 5 s.
The `/build` page shortens the flow to Submitted → IncludedInBlock →
Finalized.

### 2.4 Kurier timing — live measurements (SECONDARY) and the Finalized tension

- andruu21 (live, mainnet): txHash already exists at `Submitted`, ~4 s in;
  full finalization ~27 s, once >35 s. Inside a 60 s task window that also
  includes proving, waiting for finality "is how you turn a correct agent
  into a timing-out agent". His agent returns the txHash as soon as the
  transaction exists and lets finalization complete server-side at Kurier;
  end-to-end task time dropped from 36.5 s to 5.6 s.
- subastian1998: Kurier is best-effort with a bounded poll (20 s gatekeeper);
  the response always carries the local proof even if Kurier is slow/absent.
- **Tension (UNVERIFIED, §7.4):** checklist item (5) says "verification
  reached Finalized before approval", but no official source says whether
  the *platform* requires Finalized at response time, or whether it
  re-checks finality itself afterwards from `proof_tx`. The two live agents
  took opposite-tolerant approaches (return early vs poll ≤15–20 s).
  Treat as a CONFIG decision, not a settled fact.

---

## 3. zkVerifyJS (direct-chain alternative) — summary only

Source: https://docs.zkverify.io/overview/getting-started/zkverify-js,
https://docs.zkverify.io/handbook/quickstart.
All docs examples use the **Volta testnet** with **tVFY** (test tokens) for
fees; the mainnet session entry point is UNVERIFIED (§7.5).

- Install: `npm i zkverifyjs dotenv` (Node v24.1.0 per docs).
- Seed phrase in env (`SEED_PHRASE`); the account must hold tVFY or the
  transaction is not accepted on-chain.
- Session + submit (Groth16/snarkjs/bn128):
  ```js
  import { zkVerifySession, Library, CurveType, ZkVerifyEvents } from "zkverifyjs";
  const session = await zkVerifySession.start().Volta().withAccount(process.env.SEED_PHRASE);
  const { events } = await session.verify()
    .groth16({ library: Library.snarkjs, curve: CurveType.bn128 })
    .execute({ proofData: { vk: key, proof: proof, publicSignals: publicInputs },
               domainId: 0 });
  ```
  (`vk` = full VK object here; use `.withRegisteredVk()` + `vk: vkey.hash`
  after registering, see below. `domainId: 0` = verify-only, no aggregation
  target.)
- Events: subscribe with `session.subscribe([{ event:
  ZkVerifyEvents.NewAggregationReceipt, ... }])`; listen via `events.on(
  ZkVerifyEvents.IncludedInBlock, …)` and `Finalized`; the `txHash` can be
  checked on the zkVerify explorer.
- Register a VK once (saves fees on later submissions):
  ```js
  const { regevent } = await session.registerVerificationKey()
    .groth16({ library: Library.snarkjs, curve: CurveType.bn128 })
    .execute(key);
  ```
  then verify with the returned hash. Registration is once per circuit.
- Why Kurier is recommended for this project: no seed phrase / account /
  fee management, no session lifecycle, plain REST + polling; the docs'
  own guidance is "Start with Kurier."

---

## 4. Circuit artifacts — downloaded and verified this session

| File | Size (bytes) | SHA-256 | Source |
|---|---|---|---|
| `circuits/gatekeeper.wasm` | 1,755,820 | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` | https://agentgames.zkverify.io/circuits/gatekeeper.wasm |
| `circuits/gatekeeper_final.zkey` | 309,750 | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` | https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey |
| `circuits/gatekeeper.vkey.json` (exported here) | 5,117 | `6ce4899b3bc74d6a5c10ede61daf8820716982e1ef7e6778a5a8872ddaf28221` | `snarkjs zkey export verificationkey` (snarkjs 0.7.6) |

Sizes/hashes match the independent local runs reported by two Creator Track
authors (truncated `be00aefe…2764f` / `adfe95a4…af80d`).

- **No `.sym`, circuit source (`.circom`), or `input.json` example is
  published**: `gatekeeper.sym`, `gatekeeper.json`, `gatekeeper.circom`,
  `circuit.circom`, `input.json` under `/circuits/` all return HTTP 404
  (checked 2026-11-16). Signal names were therefore recovered by
  participants from the WASM (see §6) and confirmed by proving.
- The WASM's only human-readable template string is
  `Error in template GatekeeperEvaluation_79`; the circuit template is
  named `GatekeeperEvaluation`. WASM exports are the standard Circom
  witness-calculator set (`init`, `setInputSignal`, `getInputSignalSize`,
  `getWitness`, `getRawPrime`, …).

### Verification key (exported this session)

- `protocol: "groth16"`, `curve: "bn128"`, **`nPublic: 13`**, `IC` array
  length 14 (= nPublic + 1). Full VK saved at
  `circuits/gatekeeper.vkey.json`.
- `vk_alpha_1`: `["3645839081856895774036975481829149926497358315989905431874823549376045291070", "7837103804387890188026242880308045955319752039741130954393547453907104517760", "1"]`.
- **vkHash is NOT reproducible from the exported VK by obvious means**: one
  author tried 12 serialization variants (keccak256 and SHA-256 over compact,
  indented, and sorted JSON; curve-point fields only; flattened commitment
  data; wrapped/unwrapped forms) — none matched the registered
  `0x6b79…d77b0`. Likely zkVerify/Kurier hashes its own canonical
  serialization. **Do not try to recompute it; use the published hash and
  the `register-vk` response.**
- The registered vkHash as an integer is larger than the BN128 scalar field
  prime, so the value that appears in the public signals is the hash
  **reduced modulo p**
  (`p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`).
  `0x6b79…d77b0 mod p = 4836144126773920907502496244340012141761656471453348073975163706578152814510`
  (computed this session; matches the independent report).

---

## 5. Circuit public-input layout — EMPIRICAL (this session)

Circuit inputs (13 total; names recovered from the WASM by three independent
parties via the `getInputSignalSize` FNV-1a oracle — andruu21, subastian1998,
jotri — and confirmed here by successful proving):

```
taskId, registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer,
decision, salt (private)
```

- `decision`: `1` = APPROVE, `0` = REJECT (SECONDARY + EMPIRICAL).
- `salt`: private input, never a public signal. Its derivation is a
  participant convention, UNVERIFIED (§7.6).
- All values are field elements: envelope strings/numbers/hex reduced mod p.
  Hex values (vk hashes, addresses) are taken as big integers mod p; the
  free-form `task_id` string must be hashed to a field element (§7.7).

### Public signals (13) — order VERIFIED by generating + verifying proofs

```
[0]  Poseidon(salt, taskId)        -- commitment; NOTE salt FIRST
[1]  registeredVkHash
[2]  proofVkHash
[3]  minimum
[4]  publicBalance
[5]  expiryBlock
[6]  currentBlock
[7]  recipient
[8]  conditionRecipient
[9]  amount
[10] maxTransfer
[11] decision
[12] taskId
```

**Two corrections to the participant write-ups (established empirically):**
1. andruu21's README says the signals are
   "`[Poseidon(taskId, salt), …the 12 public inputs in the order above…]`".
   Both halves are wrong as written: the commitment is
   **Poseidon(salt, taskId)** (salt first — tested all orderings; only
   `[salt, taskId]` matched), and `taskId` is **last** (index 12), not
   second. The middle 11 signals [1..11] are the remaining inputs in
   declaration order.
2. The commitment depends only on (salt, taskId): a REJECT proof on trap
   inputs with the same taskId+salt produced the identical signal[0].

### Worked example (this session, reproducible)

Inputs: `taskId = SHA256("gk_24_9d1") mod p`, both vk hashes =
`0x6b79…d77b0 mod p`, minimum 1000, publicBalance 1460, expiryBlock
19842201, currentBlock 19832000, recipient = conditionRecipient =
`0xDe42000000000000000000000000000000009f01` (synthetic full address — the
official sample truncates it as `0xDe42...9f01`), amount 500, maxTransfer
1000, decision 1, salt 12345.
Result: `snarkjs.groth16.fullProve` succeeded; `groth16.verify` against the
exported VK returned `true`; publicSignals were:

```
["12708459702122187759074110847549171554736336742827479070073672774936114288678",
 "4836144126773920907502496244340012141761656471453348073975163706578152814510",
 "4836144126773920907502496244340012141761656471453348073975163706578152814510",
 "1000", "1460", "19842201", "19832000",
 "1268867800305995395507099298277146472967273750273",
 "1268867800305995395507099298277146472967273750273",
 "500", "1000", "1",
 "20829714751891584743724278765307997780450844889094878994196554839611267657343"]
```

and `Poseidon([salt, taskId])` (circomlibjs) equals signal[0] exactly.
Negative controls (same session): decision=1 with publicBalance 100 failed
at `GatekeeperEvaluation_79` line 102; decision=0 on the valid inputs
failed identically; decision=0 with publicBalance 100 proved and verified
(`true`).

---

## 6. Secondary sources used (and their weight)

| Source | Weight |
|---|---|
| https://github.com/andruu21/proof-gatekeeper-agent (+ dev.to article) | Live preflight "Healthy, 579 ms"; 4/4 practice tasks; public repo with handler/prover/Kurier code. |
| https://github.com/subastian1998/agent-games-season-01 (+ Medium article) | Live dashboard HEALTHY after secret set; live practice REJECT validated end-to-end; 12/12 local harness. |
| https://dev.to/bangkitnovendy11/trust-nothing-prove-everything-building-a-proof-gatekeeper-for-zkverify-agent-games-44f8 | Local-only; 12/12 local checks; vkHash non-reproduction experiment (12 variants). |
| https://dev.to/jotri/my-human-gives-one-word-orders-thats-why-my-work-needs-proofs-4p8f | Local-only; independent WASM probing (FNV-1a oracle + 461,814-candidate dictionary brute force for last two names); 804-byte proof. |
| https://medium.com/@fajargoodz/before-i-trust-an-agent-with-payments-i-make-it-prove-every-rejection-19cd7226e9c5 | Local-only; same artifact hashes + nPublic=13. |

All five agree on: envelope shape, HMAC-SHA256-over-raw-body, decision
rules/boundaries, the 13 input names, nPublic=13, artifact hashes/sizes.
They disagree on: taskId hash (SHA-256 vs keccak256) and salt derivation
(see §7).

---

## 7. UNVERIFIED details — CONFIG/TODO assumptions for implementation

1. **`issued_at` / `deadline_at` format.** Official sample shows only
   `"<issued-at>"` / `"<deadline-at>"`. Best guess: ISO 8601 strings (the
   Kurier API uses ISO timestamps); do NOT hard-code a parser — accept ISO
   8601 and Unix seconds/ms defensively, and treat an unparseable or
   past-deadline envelope as fail-closed REJECT. Timestamp-validity window
   (how stale is too stale) is also unpublished.
2. **Preflight request body beyond `type`.** Only `type:
   "agent-games.preflight.v1"` and the signed `{ok: true, protocolVersion:
   "v1"}` response are attested (secondary). Whether the preflight carries
   `task_id`, `issued_at`, `mode`, or an `input` object is unknown. Handle
   it by branching on `type` before touching any other field; never require
   task fields on a preflight.
3. **Health-check method/path.** Officially only "passing health check".
   Implement both `GET /health` and `GET` on the task path returning a
   minimal healthy JSON (do not require HMAC on GET).
4. **Does the platform require Kurier `Finalized` before it accepts the
   response?** Checklist item (5) says verification must reach Finalized
   before approval, yet live agents return the txHash at `Submitted`
   (~4 s; finalization ~27 s, once >35 s). Unknown whether the platform
   re-checks finality from `proof_tx` after the response, or scores a
   not-yet-finalized proof as missing/invalid. CONFIG: poll budget
   (e.g. 15–20 s) vs return-at-Submitted; never let Kurier block past the
   60 s deadline; never omit the local proof from the response.
5. **zkVerifyJS on mainnet.** Docs show only Volta testnet + tVFY. The
   mainnet session constructor / fee token for Agent Games is unpublished.
   Kurier is the recommended path; treat zkVerifyJS as fallback-only until
   its mainnet entry point is confirmed from docs or a live run.
6. **`salt` derivation.** Participant convention (andruu21):
   `salt = HMAC(secret, "gatekeeper-salt:" + task_id) mod p` (deterministic,
   so redelivery reproduces identical proof inputs). Subastian's repo uses
   a Poseidon-based binding with its own salt handling for Steal, and does
   not publish an equivalent gatekeeper salt formula. Any salt proves
   locally; whether the platform recomputes the commitment (and with what
   salt) is unknown. CONFIG: deterministic per-task salt, one function,
   easy to swap.
7. **`task_id` → field element mapping. CONFLICT between live sources.**
   andruu21: `SHA-256(task_id) mod p` (claims 4/4 practice tasks correct
   with it). subastian1998: `keccak256(task_id) mod p` default, with
   `numeric`/`hex` alternatives, flagged as an open item ("confirm in
   practice"). Local proving **cannot** distinguish them — any field
   element is a valid `taskId` input, and the platform is not documented
   to recompute the gatekeeper public signals from the envelope (contrast
   Steal the VFY, where the platform independently computes
   `publicInputsHash`). CONFIG: default to one (SHA-256 has the only
   practice-task evidence), keep it a one-line switch, and confirm against
   the first real practice task.
8. **HMAC key encoding of the 32-byte secret + header value encoding.**
   Officially unstated. Best-supported reading: HMAC-SHA256, lowercase hex
   (two live preflight passes). CONFIG: outbound hex; inbound accept hex,
   base64, and optional `sha256=` prefix; constant-time compare. If
   preflight fails with `FAILED (protocol)`, the encoding is the first
   thing to vary.
9. **Response minimal-vs-superset.** Official event page shows only
   `{decision, reason_code, proof_tx}`; `/build` demands the proof be
   included. The superset response (decision + reason_code + proof +
   public_signals + proof_tx) is what both live agents send. CONFIG: send
   the superset; never send proof/public_signals at top level for Steal
   (different track, different nesting — not this project's concern).
10. **`mode` value for practice tasks.** Sample shows `"competition"`;
    the practice-mode value (presumably `"practice"`) is unpublished.
    Do not branch logic on `mode` except to log it.
11. **Kurier `register-vk` exact response fields.** Docs use
    `vk.vkHash || vk.meta.vkHash`; another tutorial mentions
    `uniq_vk_hash` for already-registered keys. CONFIG: accept all three;
    assert equality with `0x6b79…d77b0` (case-insensitive) before submitting.
12. **Kurier Swagger details.** https://api.kurier.xyz/docs could not be
    fetched in this session (JS app, no extractable content). Anything
    known only from Swagger (extra query params, error schemas, rate
    limits) is unverified. Re-check from a live browser if needed.
13. **`INVALID_TASK` reason code.** Invented by andruu21 as a local
    fallback for malformed envelopes / past deadlines / internal errors; it
    is NOT in the official 7-code taxonomy. Use only for off-path failures
    and expect it to be unscored.
14. **Proof `public_signals` numeric format.** Verified as decimal strings
    in snarkjs output and in both repos. Whether the platform also accepts
    hex strings is unknown — send decimal strings exactly as snarkjs
    produces them.

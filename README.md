# Proof Gatekeeper

A deterministic, fail-closed HTTP service for the **zkVerify Agent Games —
Proof Gatekeeper** event. It receives a task, checks it against the
published rules, generates a **real Groth16 proof** (snarkjs, BN128) that
the decision is correct, verifies that proof locally, and — in `kurier`
mode — submits it to zkVerify via Kurier and polls toward `Finalized`.

There are **no model calls anywhere in the decision path**. The decision
is a pure checklist; a wrong decision is unprovable by construction (the
circuit asserts `decision == (all five field checks)`).

Spec source of truth: [`RESEARCH.md`](RESEARCH.md). Read it before
changing protocol behaviour. Where `RESEARCH.md` marks a detail
UNVERIFIED, this codebase implements it as an explicit `CONFIG` / `TODO`
(see `src/config.ts` and "Unverified protocol details" below) — never as
fact.

## How it works

```
POST /agent  (HMAC-SHA256 over the RAW body, header x-agent-games-signature)
  ├─ type == "agent-games.preflight.v1"  → signed { ok: true, protocolVersion: "v1" }
  └─ type == "agent-games.proof-gatekeeper.v1"
       ├─ validate envelope + timestamps (fail-closed)
       ├─ same task_id? → cached response (idempotent retry, NOT reuse)
       ├─ decision checklist (VK, reuse, threshold, expiry, recipient, amount)
       ├─ snarkjs groth16 fullProve + local groth16 verify (13 signals)
       ├─ kurier mode: register-vk (once) → submit-proof → poll to Finalized
       └─ signed superset response { decision, reason_code, proof,
           public_signals, proof_tx }
GET /health  → { ok: true, ... }   (no HMAC; platform health check)
GET /agent   → same healthy JSON
```

APPROVE only if **all** of: `proof_vk == registered_vk`,
`proof_tx` unseen (under a different `task_id`), `public_balance >=
minimum`, `current_block < expiry_block`, `recipient ==
condition_recipient`, `amount <= max_transfer`. Boundaries: balance ==
minimum is valid, amount == max is valid, expiry is strict
(`current == expiry` is expired).

Hard deadline: **60 s per request**. On expiry the server answers
`REJECT / TIMEOUT` and discards the in-flight work.

## Run locally

```bash
cp .env.example .env        # fill in AGENT_GAMES_HMAC_SECRET (required)
npm install
npm run build
npm start                   # listens on $PORT (default 3000)
```

The server **refuses to start** without `AGENT_GAMES_HMAC_SECRET`.
Default mode is `local`: proofs are generated and verified locally only
— nothing is submitted anywhere. Kurier submission only runs when you
explicitly set `ZKVERIFY_MODE=kurier` with a real `KURIER_API_KEY`.

Circuit artifacts are already in `circuits/` (`gatekeeper.wasm`,
`gatekeeper_final.zkey`, `gatekeeper.vkey.json`). At startup the server
verifies their size + SHA-256 against the values in `RESEARCH.md` §4 and
fails to start on mismatch.

## Test

```bash
npm test
```

The harness (`test/harness.ts`) starts the real server as a child
process and replays sample envelopes from `test/samples/` over HTTP with
real HMAC signing. It asserts:

- valid APPROVE produces a **real Groth16 proof that verifies locally**
  (`groth16.verify === true`), with `public_signals[0] ==
  Poseidon(salt, taskId)`, signals in the verified order, and the
  registered vkHash (mod p) at signals[1..2];
- all five trap REJECTs (threshold / VK / expired / recipient / amount)
  each carry a real verifying REJECT proof;
- bad/missing HMAC → 401; stale timestamp → `REJECT / STALE_TIMESTAMP`;
- replayed `proof_tx` under a new `task_id` → `REJECT / PROOF_REUSED`
  with no proof; same `task_id` retry → identical cached response;
- a 1 ms-deadline server returns `REJECT / TIMEOUT`.

It uses a throwaway HMAC secret generated for that run only. Nothing
touches Kurier or mainnet.

## Register the endpoint

1. Deploy (below) and copy the public HTTPS URL.
2. In the Agent Games dashboard, register the **full handler path**,
   e.g. `https://<host>/agent` — not the root.
3. Run the dashboard **preflight**: it POSTs
   `{ "type": "agent-games.preflight.v1", ... }` (same endpoint, same
   HMAC signing) and expects the signed `{ ok: true, protocolVersion:
   "v1" }` response. If it fails with `FAILED (protocol) — "The endpoint
   must return signed protocol-v1 JSON"`, the HMAC secret/encoding is the
   first thing to check (see "Unverified protocol details" §8).
4. Do at least one **practice task** before competition rounds, and
   confirm the first practice task's decision/proof against the
   assumptions in §6–§7 below.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | **yes** | — | Platform-generated 32-byte secret (dashboard → Rotate Secret). Hex (64 chars), base64, or raw string. Server refuses to start without it. |
| `KURIER_API_KEY` | only in kurier mode | — | From https://kurier.xyz (mainnet) / https://testnet.kurier.xyz (testnet). Key is per-environment. |
| `PORT` | no | `3000` | |
| `ZKVERIFY_MODE` | no | `local` | `local` = prove + verify locally only. `kurier` = also submit via Kurier. |
| `REQUIRE_FINALIZED` | no | `true` | `true` = only APPROVE when Kurier reports `Finalized` within budget; otherwise `REJECT / NOT_FINALIZED` (proof still included). `false` = accept once Kurier has a txHash (`Submitted`). |
| `TASK_ID_HASH` | no | `sha256` | `sha256` or `keccak256` — contested, see §7. |
| `SALT_DERIVATION` | no | `hmac` | Only `hmac` is supported (see §6). |
| `KURIER_BASE_URL` | no | `https://api.kurier.xyz/api/v1` | Mainnet. Testnet: `https://api-testnet.kurier.xyz/api/v1`. |
| `KURIER_POLL_BUDGET_MS` | no | `20000` | Max Kurier polling per request; also capped by the remaining 60 s budget (minus a 5 s reserve). |
| `KURIER_POLL_INTERVAL_MS` | no | `2000` | |
| `REQUEST_TIMEOUT_MS` | no | `60000` | Hard per-request deadline (official: 60 s). |
| `MAX_TASK_AGE_MS` | no | `600000` | Max age of `issued_at` at receipt (unpublished — guess). |
| `CLOCK_SKEW_MS` | no | `300000` | Allowed future skew for `issued_at`. |
| `CIRCUIT_DIR` | no | auto-detected | Override the circuit-artifact directory. |

## Response and reason codes

Response (superset, `RESEARCH.md` §1.4):

```json
{
  "decision": "APPROVE",
  "reason_code": "VALID_CONDITION",
  "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...],
             "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["<13 decimal strings>"],
  "proof_tx": "0x…"
}
```

**Official reason codes** (the only seven the platform scores):

| Code | Decision | Meaning |
|---|---|---|
| `VALID_CONDITION` | APPROVE | All checks passed |
| `VK_SUBSTITUTION` | REJECT | `proof_vk != registered_vk` |
| `PROOF_REUSED` | REJECT | `proof_tx` already used under a different `task_id` (no proof — a REJECT on otherwise-valid inputs is unprovable) |
| `THRESHOLD_MISMATCH` | REJECT | `public_balance < minimum` |
| `EXPIRED_CONDITION` | REJECT | `current_block >= expiry_block` |
| `RECIPIENT_MISMATCH` | REJECT | `recipient != condition_recipient` |
| `AMOUNT_OVERFLOW` | REJECT | `amount > max_transfer` |

**Off-path fallback codes** (not in the official taxonomy; expect them
unscored — used only when there is no scorable task decision):

| Code | When |
|---|---|
| `INVALID_TASK` | Malformed envelope / unknown `type` / unparseable JSON |
| `STALE_TIMESTAMP` | Unparseable, past-deadline, too-old, or future `issued_at`/`deadline_at` |
| `TIMEOUT` | The 60 s per-request deadline expired |
| `INTERNAL_ERROR` | Local proof verification failed / unexpected error |
| `PROVING_FAILED` | `fullProve` threw (should not happen for a correct decision) |
| `NOT_FINALIZED` | Kurier mode with `REQUIRE_FINALIZED=true` and no `Finalized` within budget (the local proof is still included) |

`proof_tx`: in kurier mode this is **our** proof's on-chain tx hash from
Kurier once one exists; in local mode (no submission exists) it echoes
the envelope's `proof_tx`. For `PROOF_REUSED` the response carries no
proof and `proof_tx` echoes the envelope (the official minimal shape
includes it).

Public signals (verified order, `RESEARCH.md` §5):

```
[Poseidon(salt, taskId), registeredVkHash, proofVkHash, minimum,
 publicBalance, expiryBlock, currentBlock, recipient,
 conditionRecipient, amount, maxTransfer, decision, taskId]
```

All values are decimal strings; hashes/addresses are big integers mod
the BN128 field prime `p`. The registered vkHash mod p is
`4836144126773920907502496244340012141761656471453348073975163706578152814510`.

## Deployment

### Railway (primary)

1. Push this directory to a GitHub repo (the `.wasm` / `.zkey` files are
   git-ignored — the Docker build downloads them; do **not** force-add
   them).
2. In Railway: New Project → Deploy from GitHub → pick the repo.
   Railway uses `railway.toml` (Dockerfile builder, healthcheck on
   `/health`, restart on failure).
3. In the Railway dashboard → Variables, set:
   `AGENT_GAMES_HMAC_SECRET` (the platform-generated secret),
   `ZKVERIFY_MODE` (`local` to start; `kurier` only when you are ready
   to submit for real), `KURIER_API_KEY` (only for kurier mode).
   Leave the rest at defaults unless you have a reason to change them.
4. Railway gives you a public HTTPS domain — register
   `https://<domain>/agent` in the Agent Games dashboard and run
   preflight.
5. Railway does not sleep on idle for paid plans; keep the service on a
   plan that stays awake during rounds (rounds run 13–21 Nov 2026,
   4:00 PM–2:00 AM IST).

### VPS fallback

Any cheap always-on VPS with Docker: build the image, run it with
`-e AGENT_GAMES_HMAC_SECRET=… -p 127.0.0.1:3000:3000`, and put Caddy
(or nginx) in front with automatic Let's Encrypt HTTPS proxying to
`127.0.0.1:3000`. The platform requires HTTPS.

## Security notes

- **Never commit `.env`** or any secret. All secrets come from env vars
  only. The HMAC secret must be the platform-generated value from
  Rotate Secret — never a local placeholder in production.
- Secrets are never logged. Logs contain only `task_id`, decision,
  reason, and timings.
- Fail-closed: any error, timeout, or uncertainty → REJECT. There is no
  code path that approves by default.
- HMAC is verified over the **raw body before parsing**; every response
  is signed over its raw body (`x-agent-games-signature`, lowercase
  hex HMAC-SHA256). Inbound signatures are accepted as hex, base64, or
  `sha256=`-prefixed hex, compared in constant time.
- **In-memory store is a demo-grade limitation.** `src/store.ts` keeps
  the used-`proof_tx` set and the `task_id` idempotency cache in memory:
  a restart/redeploy loses them, which could let a reused `proof_tx`
  slip through. Production deployments must move both to durable
  storage (Redis / Postgres) with the `proof_tx` set as the source of
  truth. Do not run a multi-replica deployment with the in-memory
  store — replicas would not share reuse state.
- Test on **testnet / practice tasks first**. `ZKVERIFY_MODE=local` is
  the default precisely so nothing is submitted until you opt in.
- The Dockerfile runs as the non-root `node` user and verifies the
  downloaded circuit artifacts by SHA-256 at build time.

## Unverified protocol details — confirm against the dashboard / practice tasks

Everything below is **not** established by an official source
(`RESEARCH.md` §7). Each item is implemented as a `CONFIG`/`TODO` in
`src/config.ts` with the best-supported default. Confirm each against
the first real practice task; if the platform behaves differently, the
fix is a one-line config change, not a redesign.

1. **`issued_at` / `deadline_at` format.** Official sample shows only
   `"<issued-at>"` / `"<deadline-at>"`. The server accepts ISO-8601 and
   unix seconds/ms defensively; unparseable or past-deadline envelopes
   are fail-closed REJECTs. The staleness window (`MAX_TASK_AGE_MS`,
   default 10 min) is a guess.
2. **Preflight body beyond `type`.** Only `type:
   "agent-games.preflight.v1"` and the signed `{ ok: true,
   protocolVersion: "v1" }` response are attested. The handler branches
   on `type` before touching any other field.
3. **Health-check method/path.** Officially only "passing health
   check". This service answers `GET /health` and `GET /agent`.
4. **Does the platform require Kurier `Finalized` before accepting the
   response?** Checklist item (5) says verification must reach
   Finalized before approval, but live agents returned the txHash at
   `Submitted` (~4 s; finalization ~27 s, once >35 s). Default:
   `REQUIRE_FINALIZED=true` (fail-closed, poll budget 20 s, never past
   the 60 s deadline). Set it to `false` if practice tasks show the
   platform accepts a `Submitted` txHash.
5. **zkVerifyJS on mainnet.** Docs show only the Volta testnet + tVFY.
   This project uses the Kurier REST path only; zkVerifyJS is not
   implemented (fallback-only until its mainnet entry point is
   confirmed).
6. **Salt derivation.** Participant convention:
   `salt = HMAC(secret, "gatekeeper-salt:" + task_id) mod p`
   (deterministic, so retries reproduce identical proof inputs). Any
   salt proves locally; whether the platform recomputes the
   `Poseidon(salt, taskId)` commitment — and with what salt — is
   unknown. One function in `src/config.ts` (`deriveSalt`); easy to swap.
7. **`task_id` → field element: SHA-256 vs keccak256 (contested).**
   andruu21 uses SHA-256 (claims 4/4 practice tasks); subastian1998
   uses keccak256 (flagged as an open item). Local proving cannot
   distinguish them. Default `TASK_ID_HASH=sha256` (only option with
   practice-task evidence); switch with one env var and confirm
   against the first practice task.
8. **HMAC key/header encoding.** Officially unstated. Outbound:
   lowercase hex HMAC-SHA256. Inbound: hex, base64, or `sha256=`-prefixed
   hex, constant-time compare. The 32-byte secret is decoded as hex if
   it is 64 hex chars, else base64 if it decodes to 32 bytes, else raw
   UTF-8 bytes. If preflight fails with `FAILED (protocol)`, the
   encoding is the first thing to vary.
9. **Minimal vs superset response.** The event page shows only
   `{ decision, reason_code, proof_tx }`; `/build` demands the proof be
   included. This service always sends the superset (with proof +
   public_signals), except `PROOF_REUSED` and off-path failures, which
   carry no proof.
10. **Practice `mode` value.** Sample shows `"competition"`; the
    practice-mode value (presumably `"practice"`) is unpublished. The
    service logs `mode` but never branches on it.
11. **Kurier `register-vk` response fields.** The client accepts
    `vkHash`, `meta.vkHash`, and `uniq_vk_hash`, and asserts the
    returned hash equals the published
    `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
    before submitting.
12. **Kurier Swagger details.** `https://api.kurier.xyz/docs` could not
    be read during research (JS app). Anything known only from Swagger
    (extra params, error schemas, rate limits) is unverified.
13. **`INVALID_TASK` reason code.** Invented by a participant as a
    local fallback; it is NOT in the official 7-code taxonomy. Used
    only for off-path failures; expect it to be unscored.
14. **`public_signals` numeric format.** Verified as decimal strings in
    snarkjs output and in both participant repos. Whether the platform
    also accepts hex is unknown — decimal strings are sent exactly as
    snarkjs produces them.

## Project layout

```
proof-gatekeeper/
├── RESEARCH.md            # research report — spec source of truth
├── src/
│   ├── types.ts           # envelope / response / reason-code types
│   ├── config.ts          # env parsing + ALL config/TODO assumptions
│   ├── hmac.ts            # HMAC-SHA256 sign/verify (constant-time)
│   ├── preflight.ts       # preflight distinguisher + response
│   ├── decision.ts        # deterministic checklist + timestamp checks
│   ├── prover.ts          # snarkjs fullProve + local verify + Poseidon
│   ├── zkverify.ts        # Kurier client (register/submit/poll)
│   ├── store.ts           # in-memory proof_tx + task_id store
│   └── server.ts          # HTTP entrypoint (60 s deadline, signed I/O)
├── test/
│   ├── harness.ts         # end-to-end harness (real proofs, real HTTP)
│   └── samples/*.json     # sample envelopes (valid + 5 traps + reused)
├── circuits/              # gatekeeper.wasm / .zkey / .vkey.json
├── Dockerfile             # node:20-slim, non-root, downloads + verifies circuits
├── railway.toml           # Railway deploy (Dockerfile, /health check)
├── .env.example           # blank env template
└── package.json           # scripts: build / start / dev / test
```

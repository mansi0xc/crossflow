# Service API (T32)

A bounded local service that connects the numerical engines and the chain to the browser. It holds
no user key, signs nothing, and exposes no arbitrary command surface.

```sh
corepack pnpm@10.17.1 serve:api          # http://127.0.0.1:8787
corepack pnpm@10.17.1 dev:web            # http://127.0.0.1:5173
```

Configuration comes from the environment only:

| Variable | Default | Meaning |
|---|---|---|
| `CROSSFLOW_PORT` | `8787` | listen port (bound to `127.0.0.1`) |
| `CROSSFLOW_RPC_URL` | `http://127.0.0.1:8899` | write destination; validated against the manifest genesis before the connection is created |
| `CROSSFLOW_DEVNET_MANIFEST` | `verification/evidence/T16-local-manifest.json` | the committed deployment identity the service serves |
| `CROSSFLOW_MAX_OWNERS` | `3` | largest batch the service will prepare |
| `CROSSFLOW_RATE_LIMIT` | `30` | requests per client per minute; raised for the browser suite |

## Endpoints

| Method | Path | Input | Output |
|---|---|---|---|
| GET | `/health` | — | cluster, genesis, program, config, whether routing is enabled |
| GET | `/deployment` | — | public deployment identity: program, config, policy hash, oracle mode, assets, protocol fee. Never an RPC credential or a key |
| GET | `/price` | — | the labelled fixture snapshot, with its explicit **TEST PRICES** label |
| GET | `/intents` | — | funded, settled and cancelled intents for the configured config, decoded from chain |
| POST | `/plans` | `{ scenario_id, grid_step?, scenario? }` | the three engine proposals and the attribution |
| POST | `/batches/prepare` | `{ plan, operator, technical_probe? }` | an **unsigned** settlement transaction (base64) plus a preview |

### `/plans` is not an arbitrary model runner

The request names a scenario from the committed suite. An inline `scenario` is accepted only when
its hash matches the frozen fixture, so the service cannot be used to run an arbitrary economic
model. The engine runs as a fixed executable with a fixed script path, receives JSON on stdin,
cannot reach a shell, and is killed on a deadline with a byte cap on its output. A non-integer
number anywhere in its reply is refused, because raw-unit accounting must be exact.

### `/batches/prepare` never invents a plan

The service reloads the funded mandates from chain, re-reads the fixture snapshot and every vault
balance, runs the caller's plan through the independent planner, and only then builds an
instruction. A rejected plan never becomes a transaction. The returned transaction is unsigned:
the operator wallet signs and broadcasts it, and the service reconciles the submitted signature
against chain state before anything is reported as settled.

## Bounds

Request bodies are capped (default 64 KiB), requests are rate limited per client, POST concurrency
is capped, chain reads have their own timeout, and owners are limited to three. A missing operator,
a malformed body and an unknown route are refused before any chain read.

## End-to-end status: complete

`scripts/demo-t32-service.ts` drives the whole path over HTTP on a local validator — plan, funded
intent discovery, batch preparation, operator signing, broadcast and reconciliation — and
`scripts/check-t32-local-evidence.mjs` verifies the transcript. A passing run:

1. `GET /health`, `GET /deployment`, `GET /price` report the configured local deployment;
2. `POST /plans` runs the real numerical engine and returns all three proposals;
3. `GET /intents` reads the funded intents from chain, in raw owner-byte order;
4. the operator publishes an address lookup table (the service never creates or owns it);
5. `POST /batches/prepare` validates the plan through the independent planner and returns an
   **unsigned** versioned transaction, which is required to be **byte-equivalent** to one a local
   client builds from the same validated plan;
6. the operator wallet signs and broadcasts it, and pays the network fee;
7. `GET /intents` is re-read and every funded participant must now report `Settled`.

Four defects were found by building this and are fixed: the service ignored its documented
environment variables and served a different deployment; the mandate context carried base58
identities where the canonical encoder requires hex (genesis, program id, config, owner, recipient
ATA and publisher); the prepared transaction carried no compute-budget instruction and would have
run on the 200k default; and a supplied lookup table was reported in the preview but never used to
compile the message. A fifth was an address-lookup-table activation race — waiting on the confirmed
slot instead of the rooted one lets the leader silently drop the transaction.

## What this service is not

It is not a hosted multi-tenant backend: it binds to loopback, serves one configured deployment,
holds no user keys and has no authentication, because it is a local operator tool. The chain stays
the authority — a fabricated index entry cannot become a signable batch, and persistent recovery
comes from intents on chain rather than from service state.

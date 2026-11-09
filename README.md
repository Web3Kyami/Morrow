# Morrow

**Live demo:** https://morrow.169-58-183-115.sslip.io

Morrow connects support decisions to payment evidence, merchant approval, and confirmed access. Its TypeScript server checks a Sui Testnet payment through Tatum, records the operator's decision, grants an entitlement once, and reads it back from PostgreSQL. Approved operational lessons have a separate Walrus Memory lifecycle.

## Run the server

Use Node.js 24 or later, pnpm, and PostgreSQL. Neon is the hosted database. Install dependencies with `pnpm install --frozen-lockfile`, copy `.env.example` to a private `.env`, and supply the database connection strings. `DIRECT_URL` is the migration owner connection; `DATABASE_URL` must use the restricted application role.

Run `pnpm db:migrate`, then `pnpm db:runtime` to create or reconcile the restricted `morrow_app` role. The latter stores the generated application connection in the private environment file without printing it. An existing role's credential is never rotated by this command. Run `pnpm build` and `pnpm start`. The server listens on loopback port 3100 by default. `pnpm env:check` reports variable presence without values.

The HTTP surface is under `/api/v1/cases/:caseId`: read the case, create an `investigations` entry, record a `decisions` entry, or request a `repairs` entry. Judge routes require a scoped, expiring demo bearer session with a durable request limit. Customer help uses an ownership-checked case token, and merchant routes use an HttpOnly, SameSite=Strict cookie. Merchant sign-in is credential-checked independently of the public demo switch. Production merchant access uses a Privy access token verified on the server, then resolves a pre-provisioned Privy-user-to-merchant mapping. Configure both `PRIVY_APP_ID` and server-only `PRIVY_VERIFICATION_KEY`, then run `pnpm privy:link` with the verified Privy user ID and existing merchant tenant/operator IDs. The linked subject is stored as a hash; client-supplied tenant and role fields are rejected. Local fixture password sign-in is opt-in with `MERCHANT_FIXTURE_LOGIN_ENABLED=true` and is rejected when `NODE_ENV=production`. Password recovery is unavailable until a delivery provider is configured. Session cookies require HTTPS by default; local HTTP development must explicitly set `SESSION_COOKIE_SECURE=false`. Demo access is disabled by default. Production merchant sign-in has no permissive fallback.

## Isolated Testnet demo

With `DEMO_ENABLED=true`, `POST /api/v1/demo/sessions` requires a randomly generated `Idempotency-Key` of 32 to 128 URL-safe characters. Treat it as a private recovery capability. Repeating it returns the same run, token and prepared payment data until the session expires or is reset. Receipts are encrypted using that client-held capability; no raw session token or recovery key is stored in the database.

The run links isolated cases A, B and C. Start the separate bounded Testnet worker with `pnpm demo:worker` on the configured host. The web process never loads signing keys. The worker uses the existing registered shared payer and recipient, reserves exact transaction bytes and gas before signing, and reconciles uncertain submissions by digest. It allows at most 20 operations and 100,000,000 MIST of worst-case reserved transfer plus gas per UTC day. It coordinates through the shared payer lock. No new wallets or Mainnet transactions are created.

The guided demo completes A through a real payment check, read-only investigation, explicit human repair approval, persisted entitlement readback, editable sanitized lesson draft, separate lesson approval, asynchronous Walrus Testnet storage and fresh exact recall. Only then can B's payment begin. B runs OFF first, persists the baseline across refreshes, then runs ON against the same frozen case evidence and model with fresh scoped A-only lesson recall. Both arms are read-only. Equal, different and inconclusive results are reported without a causal improvement claim. Explicit approved lesson scope can include courses and downloads; old lessons retain their original narrow category.

Configure the existing server-only `OPENROUTER_API_KEY` and a tool-capable `OPENROUTER_MODEL` ending in `:free` for actual model calls. Each investigation is bounded to two requests, a scoped `read_case` tool and a validated proposal. Missing configuration selects the explicitly labelled deterministic planner. A provider failure does not silently switch models or authorize an effect. Database tests use a separate disposable database, never the runtime database.

The linked A/B/C flow and run-bound proof view keep each case attached to one demo session. Case C expects an amount one MIST above its prepared transaction, so a successful transaction must fail the exact payment check and cannot grant access. Merchant tools include correction requests, versioned lesson drafts and a lesson library. A correction request records the issue; the merchant must update the canonical source elsewhere before rechecking. Password recovery is unavailable until a delivery provider is configured. Mainnet memory remains a separate ten-memory gate. The legacy manual unsigned-payment endpoints remain available for existing integrations. Demo state is session-scoped and expires after one hour; refreshing cannot revive an expired or reset session. Gas object reservations do not expire automatically because already prepared bytes may remain executable.

## Boundaries

- Payment intents reserve the exact transaction digest before broadcast. Matching also requires the sender, recipient, native SUI amount, checkpoint, and intent time window. Successful payment alone does not grant access.
- A versioned approval is rechecked against current operator rights, tenant, policy, case, and fresh payment evidence before a repair. PostgreSQL constraints and transactions prevent duplicate grants. A separate read confirms the resulting entitlement.
- Tenant queries use transaction-local context and forced row security. Immutable intents, decisions, payment observations, repairs, and audit records preserve the decision trail.
- Walrus job acceptance, pending upload, completed storage, and verified recall are distinct states. A closed lesson vocabulary excludes customer transcripts and credentials. Only authenticated merchant lesson routes can approve and advance a lesson in that merchant's namespace. Public customer routes cannot write memory.
- Sui payment and Walrus Memory networks are separate configuration choices. Testnet memories never count toward the Mainnet gate. Foundation code refuses Mainnet writes; promotion requires an explicitly authorized implementation step.

## Verification and provider proofs

`pnpm test` checks deterministic payment matching and memory-proof rules. `pnpm test:db` requires explicit disposable `TEST_DATABASE_URL` and restricted `TEST_RUNTIME_DATABASE_URL` connections. It exercises authorization, concurrent repair retries, policy changes, refusal, audit integrity, scoped sessions, and the HTTP resolution path. External payment and memory responses in those regression tests are fictional fixtures, not live provider evidence. `pnpm verify` runs type checks, both suites, and the build.

For a live Sui Testnet payment, configure the existing payer and recipient addresses plus Tatum access, then run `pnpm payment:reserve`. This prepares an unsigned native SUI transfer and persists its order binding before broadcast. The existing signer must sign and submit those exact bytes before the intent expires. The command creates no wallet and sends no transaction. `pnpm proof:payment:testnet` checks the confirmed transaction through Tatum and exercises an isolated demo approval and persisted repair.

`pnpm proof:memory:testnet` submits a fixed, fictional operational probe through Walrus Memory Testnet, saves its accepted job, and polls that same job on later runs. After completion, `pnpm proof:memory:recall` checks the exact blob and content in a new process. This standalone provider probe does not claim a customer repair occurred. `LessonService` separately requires an approved lesson grounded in an executed repair and current persisted access.

`pnpm proof:mainnet` is a provider-read-only gate. It requires successful Testnet proof, a separate Mainnet account, a scoped namespace, and ten distinct approved, completed Mainnet memories with fresh recall. It cannot create those memories or initiate a payment. Proof artifacts and signing inputs stay in private `.morrow/`; environment secrets, design handoffs, and internal continuation documents are excluded from Git and deployment inputs.

MIT license. Sui and Walrus integrations use the Mysten SDKs; Tatum supplies the payment RPC gateway.

The interface self-hosts Instrument Sans and IBM Plex Mono under the SIL Open Font License. Their license notices are included alongside the font files in `web/`.

The dropdown caret is exported from the approved Figma component using Phosphor Regular (MIT); its license notice is included in `web/phosphor-license.txt`.

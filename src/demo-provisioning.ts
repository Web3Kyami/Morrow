import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { z } from "zod";
import { authorizeOperator, type Actor } from "./authorization.js";
import type { ResolutionService } from "./resolution.js";
import type { Database } from "./database.js";
import { DomainError } from "./errors.js";
import { hash } from "./customer.js";
import { tatumClient } from "./providers/tatum.js";

/**
 * B2 isolated demo provisioning. Creates one demo tenant, judge operator,
 * order, precommitted Testnet intent, case, order reference and a 1-hour
 * demo session. Never signs, broadcasts or pays: the caller receives the
 * exact unsigned bytes whose digest was reserved, and a later payment check
 * still requires real Tatum evidence for that digest.
 */
export const reservedIntentSchema = z
  .object({
    digest: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,50}$/),
    sender: z.string().regex(/^0x[0-9a-f]{64}$/),
    recipient: z.string().regex(/^0x[0-9a-f]{64}$/),
    amount: z.string().regex(/^[1-9][0-9]{0,19}$/),
    transactionBytes: z.string().min(1),
    gasRefs: z.array(z.string().min(1)).min(1).max(256),
    gasBudget: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type ReservedIntent = z.infer<typeof reservedIntentSchema>;
export type IntentBuilder = () => Promise<ReservedIntent>;

export const DEMO_EMAIL = "buyer@example.test";
export const DEMO_BASE_AMOUNT = 1_000_000n;
export const MIST_PER_SUI = 1_000_000_000n;

/** Exact MIST -> SUI decimal string. No floating point. */
export function mistToSui(mist: string): string {
  const value = BigInt(mist);
  const whole = value / MIST_PER_SUI;
  const frac = value % MIST_PER_SUI;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

/** Per-run distinct amount: base 0.001 SUI plus a small unique offset.
 * The exact amount is reserved in the intent and returned to the caller,
 * so payment verification checks that exact amount. This makes each run's
 * unsigned bytes/digest distinct even when the shared payer gas objects
 * are unchanged between builds. */
export function demoAmountForOffset(offset: bigint): bigint {
  return DEMO_BASE_AMOUNT + offset;
}

/** Real builder: builds the exact unsigned Testnet transfer (read-only
 * Tatum client), mirroring scripts/reserve-testnet.ts. Testnet only. */
export async function buildTatumDemoIntent(
  env: {
    TATUM_API_KEY?: string | undefined;
    DEMO_SUI_PAYER_ADDRESS?: string | undefined;
    DEMO_SUI_RECIPIENT_ADDRESS?: string | undefined;
    SUI_PAYMENT_NETWORK?: string | undefined;
  },
  amountOffset?: bigint,
): Promise<ReservedIntent> {
  if (
    !env.TATUM_API_KEY ||
    !env.DEMO_SUI_PAYER_ADDRESS ||
    !env.DEMO_SUI_RECIPIENT_ADDRESS
  )
    throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
  if (env.SUI_PAYMENT_NETWORK && env.SUI_PAYMENT_NETWORK !== "testnet")
    throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
  const sender = normalizeSuiAddress(env.DEMO_SUI_PAYER_ADDRESS);
  const recipient = normalizeSuiAddress(env.DEMO_SUI_RECIPIENT_ADDRESS);
  if (sender === recipient)
    throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
  // Tatum rate-limits rapid builds (429). Retry a few times with backoff;
  // each retry uses a fresh random amount, so a successful retry is distinct.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { client, close } = tatumClient(env.TATUM_API_KEY);
    const tx = new Transaction();
    tx.setSender(sender);
    const offset =
      amountOffset ?? BigInt(randomInt(1, 100_000)) + BigInt(attempt * 100_000);
    const amount = demoAmountForOffset(offset);
    const [coin] = tx.splitCoins(tx.gas, [amount]);
    tx.transferObjects([coin!], recipient);
    let bytes: Uint8Array;
    try {
      bytes = await tx.build({ client });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      close();
      if (message.includes("429") && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
    }
    close();
    const digest = await Transaction.from(bytes).getDigest();
    return reservedIntentSchema.parse({
      digest,
      sender,
      recipient,
      amount: amount.toString(),
      transactionBytes: Buffer.from(bytes).toString("base64"),
      gasBudget: Transaction.from(bytes).getData().gasData.budget!,
      gasRefs: Transaction.from(bytes)
        .getData()
        .gasData.payment!.map((g) => `${g.objectId}:${g.version}:${g.digest}`),
    });
  }
  throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
}

type Role = "A" | "B" | "C";
type Payment = {
  network: "testnet";
  digest: string;
  sender: string;
  recipient: string;
  amount: string;
  amountMist: string;
  amountSui: string;
  transactionAmountMist: string;
  transactionAmountSui: string;
  coinType: string;
  expiresAt: string;
  transactionBytes: string;
  instruction: string;
};
type Run = {
  caseId: string;
  caseBId: string;
  caseCId: string;
  tenantId: string;
  operatorId: string;
  orderId: string;
  token: string;
  orderRef: string;
  demoEmail: string;
  resumed: boolean;
  payment: Payment | null;
  payments: Record<Role, Payment | null>;
};
// The client-held random retry capability encrypts replay data. The server
// persists only its hash and ciphertext, never this key or a raw token.
function seal(key: string, run: Run) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(key).digest(),
    iv,
  );
  const data = Buffer.concat([
    cipher.update(JSON.stringify(run), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
function unseal(key: string, text: string): Run {
  const data = Buffer.from(text, "base64");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(key).digest(),
    data.subarray(0, 12),
  );
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(
      "utf8",
    ),
  );
}
function payment(intent: ReservedIntent, role: Role): Payment {
  const expected =
    role === "C" ? (BigInt(intent.amount) + 1n).toString() : intent.amount;
  return {
    network: "testnet",
    digest: intent.digest,
    sender: intent.sender,
    recipient: intent.recipient,
    amount: expected,
    amountMist: expected,
    amountSui: mistToSui(expected),
    transactionAmountMist: intent.amount,
    transactionAmountSui: mistToSui(intent.amount),
    coinType: "0x2::sui::SUI",
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    transactionBytes: intent.transactionBytes,
    instruction:
      "The configured payer must sign and broadcast these exact bytes on Sui Testnet. No transaction has been signed or sent.",
  };
}
export class DemoProvisioningService {
  constructor(
    private readonly pool: Database,
    private readonly buildIntent?: IntentBuilder,
    private readonly options: { deferPayments?: boolean } = {},
  ) {}

  private async withRun<T>(
    key: string,
    action: (
      db: import("pg").PoolClient,
      keyHash: string,
      run: Run | null,
    ) => Promise<T>,
  ) {
    const keyHash = createHash("sha256").update(key).digest("hex");
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        keyHash,
      ]);
      const found = await db.query(
        "SELECT * FROM morrow.lookup_demo_receipt($1)",
        [keyHash],
      );
      const row = found.rows[0];
      if (
        row &&
        (!Number.isFinite(new Date(row.expires_at).getTime()) ||
          new Date(row.expires_at).getTime() <= Date.now())
      )
        throw new DomainError("DEMO_SESSION_EXPIRED", 410);
      const run = row ? unseal(key, row.ciphertext) : null;
      const result = await action(db, keyHash, run);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  private async reserve(
    db: import("pg").PoolClient,
    run: Run,
    caseId: string,
    intent: ReservedIntent,
  ) {
    for (const ref of intent.gasRefs) {
      const result = await db.query(
        `INSERT INTO morrow.demo_gas_reservations(gas_ref,tenant_id,case_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING gas_ref`,
        [ref, run.tenantId, caseId],
      );
      if (!result.rowCount) throw new DomainError("DEMO_PAYMENT_PENDING", 409);
    }
  }
  private async save(
    db: import("pg").PoolClient,
    key: string,
    keyHash: string,
    run: Run,
  ) {
    await db.query("SELECT set_config('morrow.tenant_id',$1,true)", [
      run.tenantId,
    ]);
    await db.query(
      `INSERT INTO morrow.demo_run_receipts(key_hash,tenant_id,ciphertext,expires_at)
      VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')
      ON CONFLICT(key_hash) DO UPDATE SET ciphertext=EXCLUDED.ciphertext`,
      [keyHash, run.tenantId, seal(key, run)],
    );
  }
  async provision(
    idempotencyKey: string = randomUUID(),
    allowCreate: () => boolean = () => true,
  ): Promise<Run> {
    return this.withRun(idempotencyKey, async (db, keyHash, existing) => {
      if (existing) return { ...existing, resumed: true };
      if (!allowCreate()) throw new DomainError("INTAKE_RATE_LIMITED", 429);
      if (!this.buildIntent && !this.options.deferPayments)
        throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
      for (let attempt = 0; attempt < 3; attempt++) {
        const intent = this.options.deferPayments
          ? null
          : reservedIntentSchema.parse(await this.buildIntent!());
        if (intent && intent.sender === intent.recipient)
          throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
        const tenantId = randomUUID(),
          operatorId = randomUUID(),
          orderRef = `MRW-${randomBytes(4).toString("hex").toUpperCase()}`;
        const token = randomBytes(32).toString("base64url");
        const roles: Role[] = ["A", "B", "C"];
        const cases = roles.map((role, idx) => ({
          case_id: randomUUID(),
          order_id: randomUUID(),
          role,
          digest: idx === 0 && intent ? intent.digest : null,
          sender: intent?.sender ?? null,
          recipient: intent?.recipient ?? null,
          amount: intent?.amount ?? null,
          reference_hash: hash(
            idx === 0
              ? orderRef
              : `MRW-${randomBytes(4).toString("hex").toUpperCase()}`,
          ),
        }));
        await db.query("SAVEPOINT create_run");
        try {
          await db.query(
            `SELECT * FROM morrow.provision_demo_run($1,$2,$3,$4,$5,$6::jsonb)`,
            [
              tenantId,
              operatorId,
              createHash("sha256").update(token).digest("hex"),
              keyHash,
              hash(DEMO_EMAIL),
              JSON.stringify(cases),
            ],
          );
          const pay = intent ? payment(intent, "A") : null;
          const run: Run = {
            tenantId,
            operatorId,
            orderRef,
            token,
            orderId: cases[0]!.order_id,
            caseId: cases[0]!.case_id,
            caseBId: cases[1]!.case_id,
            caseCId: cases[2]!.case_id,
            demoEmail: DEMO_EMAIL,
            resumed: false,
            payment: pay,
            payments: { A: pay, B: null, C: null },
          };
          if (intent) await this.reserve(db, run, run.caseId, intent);
          else
            await db.query(
              "INSERT INTO morrow.demo_payment_jobs(tenant_id,case_id,operator_id,role) VALUES($1,$2,$3,'A')",
              [tenantId, run.caseId, operatorId],
            );
          await this.save(db, idempotencyKey, keyHash, run);
          return run;
        } catch (error) {
          await db.query("ROLLBACK TO SAVEPOINT create_run");
          if ((error as { code?: string }).code === "23505" && attempt < 2)
            continue;
          throw error;
        }
      }
      throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
    });
  }
  async recover(actor: Actor, key: string) {
    return this.withRun(key, async (db, _hash, run) => {
      if (
        !run ||
        run.tenantId !== actor.tenantId ||
        run.operatorId !== actor.operatorId
      )
        throw new DomainError("CASE_NOT_FOUND", 404);
      await db.query("SELECT set_config('morrow.tenant_id',$1,true)", [
        run.tenantId,
      ]);
      await authorizeOperator(db, actor);
      return run;
    });
  }
  async prepare(
    actor: Actor,
    key: string,
    role: "B" | "C",
    resolution: ResolutionService,
  ) {
    return this.withRun(key, async (db, keyHash, run) => {
      if (
        !run ||
        run.tenantId !== actor.tenantId ||
        run.operatorId !== actor.operatorId
      )
        throw new DomainError("CASE_NOT_FOUND", 404);
      await db.query("SELECT set_config('morrow.tenant_id',$1,true)", [
        run.tenantId,
      ]);
      await authorizeOperator(db, actor);
      if (run.payments[role]) return run;
      const preceding = role === "B" ? run.caseId : run.caseBId;
      const checked = await resolution.investigate(actor, preceding);
      if (checked.verdict !== "MATCH")
        throw new DomainError("PREVIOUS_PAYMENT_UNCONFIRMED", 409);
      if (!this.buildIntent)
        throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
      const intent = reservedIntentSchema.parse(await this.buildIntent());
      const caseId = role === "B" ? run.caseBId : run.caseCId;
      const pay = payment(intent, role);
      await db.query("SELECT set_config('morrow.tenant_id',$1,true)", [
        run.tenantId,
      ]);
      await this.reserve(db, run, caseId, intent);
      await db.query(
        `SELECT morrow.prepare_demo_payment($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          run.tenantId,
          actor.operatorId,
          caseId,
          intent.digest,
          intent.sender,
          intent.recipient,
          pay.amountMist,
          pay.expiresAt,
        ],
      );
      run.payments[role] = pay;
      await this.save(db, key, keyHash, run);
      return run;
    });
  }
}

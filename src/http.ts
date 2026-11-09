import { draftUpdateSchema, type DemoJourneyService } from "./demo-journey.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import type { Database } from "./database.js";
import { tenantTransaction } from "./database.js";
import { DomainError } from "./errors.js";
import { authorizeOperator } from "./authorization.js";
import { CustomerService, intakeSchema } from "./customer.js";
import { FairComparisonService } from "./fair.js";
import { DemoProvisioningService } from "./demo-provisioning.js";
import { InvestigationService } from "./investigation.js";
import { merchantLessonsFor } from "./lesson-factory.js";
import { walrusGateway } from "./providers/walrus.js";
import { MerchantService } from "./merchant.js";
import { merchantProviderStatus } from "./provider-status.js";
import {
  MerchantLessonService,
  merchantLessonCategory,
  merchantLessonEditSchema,
} from "./merchant-lessons.js";
import {
  ResolutionService,
  decisionRequestSchema,
  decisionSchema,
  repairSchema,
} from "./resolution.js";
import type { Actor } from "./authorization.js";

const COOKIE_NAME = "morrow_merchant_session";

function readCookie(request: { headers: { cookie?: string | undefined } }) {
  const raw = request.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function sameOrigin(request: { headers: { origin?: string; host?: string } }) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.host === (request.headers.host ?? "");
  } catch {
    return false;
  }
}

export function createApp(
  pool: Database,
  service: ResolutionService,
  options: {
    demoEnabled: boolean;
    secureCookies?: boolean;
    staticDir?: string;
    merchantLessons?: typeof merchantLessonsFor;
    providerStatus?: (actor: Actor) => Promise<unknown>;
    demoJourney?: DemoJourneyService;
    fixtureLoginEnabled?: boolean;
    privyAppId?: string | null;
  },
  customer?: CustomerService,
  merchant?: MerchantService,
  investigation?: InvestigationService,
  fair?: FairComparisonService,
  provisioning?: DemoProvisioningService,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16_384,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    trustProxy: false,
  });
  const secureCookie = options.secureCookies === false ? "" : "; Secure";
  // Simple per-IP budget for the public intake route (demo scope guard only;
  // the database quota per order reference is the enforceable bound).
  const intakeHits = new Map<string, number[]>();
  const intakeAllowed = (ip: string) => {
    const now = Date.now();
    const hits = (intakeHits.get(ip) ?? []).filter((t) => now - t < 60_000);
    hits.push(now);
    intakeHits.set(ip, hits);
    return hits.length <= 10;
  };

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    if (request.url.startsWith("/api/") || request.url === "/health") {
      reply.header(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'",
      );
    } else {
      const loginWithPrivy =
        request.url === "/merchant/login" && Boolean(options.privyAppId);
      reply.header(
        "Content-Security-Policy",
        loginWithPrivy
          ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://privy.io https://*.privy.io; font-src 'self' data: https://privy.io https://*.privy.io; connect-src 'self' https://privy.io https://*.privy.io wss://*.privy.io; frame-src https://privy.io https://*.privy.io; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
          : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (error instanceof DomainError)
      return reply
        .code(error.status)
        .send({ error: error.code, requestId: request.id });
    if (error instanceof ZodError || statusCode === 400)
      return reply
        .code(400)
        .send({ error: "INVALID_REQUEST", requestId: request.id });
    if (statusCode === 413)
      return reply
        .code(413)
        .send({ error: "REQUEST_TOO_LARGE", requestId: request.id });
    if (statusCode === 404)
      return reply
        .code(404)
        .send({ error: "NOT_FOUND", requestId: request.id });
    return reply
      .code(503)
      .send({ error: "SERVICE_UNAVAILABLE", requestId: request.id });
  });
  app.get("/health", async () => ({ status: "ok" }));

  // Same-origin CORS preflight for browser pages on this origin only.
  app.options("*", async (request, reply) => {
    if (!sameOrigin(request as never))
      throw new DomainError("ORIGIN_NOT_ALLOWED", 403);
    reply
      .header("Access-Control-Allow-Origin", request.headers.origin)
      .header("Vary", "Origin")
      .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      .header("Access-Control-Allow-Headers", "authorization, content-type")
      .header("Access-Control-Max-Age", "60")
      .code(204)
      .send();
  });
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.headers.origin &&
      !sameOrigin(request as never) &&
      request.url.startsWith("/api/")
    )
      throw new DomainError("ORIGIN_NOT_ALLOWED", 403);
    if (request.headers.origin && sameOrigin(request as never)) {
      reply
        .header("Access-Control-Allow-Origin", request.headers.origin)
        .header("Vary", "Origin");
    }
  });

  // ---- B2 isolated demo provisioning (pre-auth, demo-only, rate-limited) ----
  const provisioningHits = new Map<string, number[]>();
  const provisioningAllowed = (ip: string) => {
    const now = Date.now();
    const hits = (provisioningHits.get(ip) ?? []).filter(
      (t) => now - t < 3_600_000,
    );
    hits.push(now);
    provisioningHits.set(ip, hits);
    return hits.length <= 5;
  };
  app.post("/api/v1/demo/sessions", async (request, reply) => {
    if (!options.demoEnabled || !provisioning)
      throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    if (request.body !== undefined) z.object({}).strict().parse(request.body);
    const key = z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .parse(request.headers["idempotency-key"]);
    const provisioned = await provisioning.provision(key, () =>
      provisioningAllowed(request.ip),
    );
    return reply.code(provisioned.resumed ? 200 : 201).send(provisioned);
  });

  // ---- S4 customer intake and status (demo fixture, quota-limited) ----
  app.post("/api/v1/help-requests", async (request) => {
    if (!options.demoEnabled || !customer)
      throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    if (!intakeAllowed(request.ip))
      throw new DomainError("INTAKE_RATE_LIMITED", 429);
    const body = intakeSchema.parse(request.body);
    return customer.intake(body);
  });
  app.get("/api/v1/help-cases/:caseId", async (request) => {
    if (!options.demoEnabled || !customer)
      throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    const caseId = (request.params as { caseId?: unknown }).caseId;
    if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
      throw new DomainError("CASE_NOT_FOUND", 404);
    const match = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    );
    if (!match) throw new DomainError("INVALID_ACCESS_TOKEN", 403);
    return customer.status(caseId, match[1]!);
  });

  // ---- Merchant desk identity providers, HttpOnly session cookie ----
  const loginHits = new Map<string, number[]>();
  const loginAllowed = (ip: string) => {
    const now = Date.now();
    const hits = (loginHits.get(ip) ?? []).filter((t) => now - t < 60_000);
    hits.push(now);
    loginHits.set(ip, hits);
    return hits.length <= 10;
  };
  const requireMerchant = async (request: {
    headers: { cookie?: string | undefined };
  }): Promise<Actor> => {
    if (!merchant) throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    const token = readCookie(request as never);
    if (!token) throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    return merchant.authenticate(token);
  };
  const merchantSessionSchema = z
    .object({
      email: z.email(),
      password: z.string().min(1).max(200),
    })
    .strict();
  app.get("/api/v1/merchant/auth/config", async () => ({
    privy: {
      enabled: Boolean(
        options.privyAppId && options.privyAppId === merchant?.privyAppId,
      ),
      appId:
        options.privyAppId && options.privyAppId === merchant?.privyAppId
          ? options.privyAppId
          : null,
    },
    fixtureLoginEnabled: options.fixtureLoginEnabled === true,
  }));
  app.post("/api/v1/merchant/session", async (request, reply) => {
    if (!merchant) throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    if (!options.fixtureLoginEnabled)
      throw new DomainError("FIXTURE_LOGIN_DISABLED", 503);
    if (!loginAllowed(request.ip))
      throw new DomainError("INTAKE_RATE_LIMITED", 429);
    const body = merchantSessionSchema.parse(request.body);
    const session = await merchant.login(body.email, body.password);
    reply.header(
      "Set-Cookie",
      `${COOKIE_NAME}=${session.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=28800${secureCookie}`,
    );
    return { ok: true };
  });
  app.post("/api/v1/merchant/session/privy", async (request, reply) => {
    if (
      !merchant ||
      !options.privyAppId ||
      options.privyAppId !== merchant.privyAppId
    )
      throw new DomainError("IDENTITY_PROVIDER_UNAVAILABLE", 503);
    if (!loginAllowed(request.ip))
      throw new DomainError("INTAKE_RATE_LIMITED", 429);
    if (request.body !== undefined) z.object({}).strict().parse(request.body);
    const match = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_.-]{20,8192})$/,
    );
    if (!match) throw new DomainError("INVALID_CREDENTIALS", 401);
    const session = await merchant.loginWithPrivy(match[1]!);
    reply.header(
      "Set-Cookie",
      `${COOKIE_NAME}=${session.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=28800${secureCookie}`,
    );
    return { ok: true };
  });
  // Identity adapter handoff: login is server-verified (scrypt + session),
  // but no recovery channel (email delivery) is configured, so recovery is
  // explicitly rejected instead of faking a flow. Generic response: the
  // email's existence is never revealed.
  app.post("/api/v1/merchant/password-recovery", async (request) => {
    z.object({ email: z.email() }).strict().parse(request.body);
    throw new DomainError("IDENTITY_RECOVERY_NOT_CONFIGURED", 503);
  });
  app.post("/api/v1/merchant/session/logout", async (request, reply) => {
    if (!merchant) throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    const token = readCookie(request as never);
    if (token) await merchant.logout(token);
    reply.header(
      "Set-Cookie",
      `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secureCookie}`,
    );
    return { ok: true };
  });
  app.get("/api/v1/merchant/cases", async (request) => {
    const actor = await requireMerchant(request as never);
    const q = (request.query as { q?: unknown }).q;
    return merchant!.queue(actor, typeof q === "string" ? q : undefined);
  });
  app.get("/api/v1/merchant/cases/:caseId", async (request) => {
    const actor = await requireMerchant(request as never);
    const caseId = (request.params as { caseId?: unknown }).caseId;
    if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
      throw new DomainError("CASE_NOT_FOUND", 404);
    return merchant!.detail(actor, caseId);
  });
  app.post("/api/v1/merchant/cases/:caseId/investigations", async (request) => {
    const actor = await requireMerchant(request);
    const { caseId } = z.object({ caseId: z.uuid() }).parse(request.params);
    return service.investigate(actor, caseId);
  });
  // ---- S7 merchant decisions + executed repair (server rechecks everything) ----
  app.post(
    "/api/v1/merchant/cases/:caseId/decisions",
    async (request, reply) => {
      const actor = await requireMerchant(request as never);
      const caseId = (request.params as { caseId?: unknown }).caseId;
      if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
        throw new DomainError("CASE_NOT_FOUND", 404);
      const body = decisionRequestSchema.parse(request.body);
      return reply
        .code(201)
        .send(await service.decide(actor, { ...body, caseId }));
    },
  );
  app.post("/api/v1/merchant/cases/:caseId/repairs", async (request) => {
    const actor = await requireMerchant(request as never);
    const caseId = (request.params as { caseId?: unknown }).caseId;
    if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
      throw new DomainError("CASE_NOT_FOUND", 404);
    const body = repairSchema.omit({ caseId: true }).parse(request.body);
    return service.repair(actor, { ...body, caseId });
  });
  // ---- S8 lessons: approve → advance → fresh recall (tenant namespace) ----
  const lessonWire = (tenantId: string) =>
    options.merchantLessons?.(pool, tenantId) ?? null;
  const merchantLessonService = new MerchantLessonService(pool);
  app.get("/api/v1/merchant/lessons", async (request) => {
    const actor = await requireMerchant(request as never);
    const query = (request.query as { q?: unknown }).q;
    if (
      query !== undefined &&
      (typeof query !== "string" || query.length > 100)
    )
      throw new DomainError("INVALID_REQUEST", 400);
    return merchantLessonService.library(actor, query ?? "");
  });
  app.get("/api/v1/merchant/providers", async (request) => {
    const actor = await requireMerchant(request as never);
    return options.providerStatus
      ? options.providerStatus(actor)
      : merchantProviderStatus(pool, actor);
  });
  app.post("/api/v1/merchant/cases/:caseId/lesson-draft", async (request) => {
    const actor = await requireMerchant(request as never);
    const caseId = (request.params as { caseId?: unknown }).caseId;
    if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
      throw new DomainError("CASE_NOT_FOUND", 404);
    const body = z
      .object({ productCategory: merchantLessonCategory })
      .strict()
      .parse(request.body);
    return merchantLessonService.openDraft(actor, caseId, body.productCategory);
  });
  app.get("/api/v1/merchant/cases/:caseId/lesson-draft", async (request) => {
    const actor = await requireMerchant(request as never);
    const caseId = (request.params as { caseId?: unknown }).caseId;
    if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
      throw new DomainError("CASE_NOT_FOUND", 404);
    return merchantLessonService.getDraft(actor, caseId);
  });
  app.put("/api/v1/merchant/cases/:caseId/lesson-draft", async (request) => {
    const actor = await requireMerchant(request as never);
    const caseId = (request.params as { caseId?: unknown }).caseId;
    if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
      throw new DomainError("CASE_NOT_FOUND", 404);
    return merchantLessonService.saveDraft(
      actor,
      caseId,
      merchantLessonEditSchema.parse(request.body),
    );
  });
  app.post(
    "/api/v1/merchant/cases/:caseId/lesson-draft/approve",
    async (request) => {
      const actor = await requireMerchant(request as never);
      const caseId = (request.params as { caseId?: unknown }).caseId;
      if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
        throw new DomainError("CASE_NOT_FOUND", 404);
      const { version } = z
        .object({ version: z.number().int().positive() })
        .strict()
        .parse(request.body);
      const lessons = lessonWire(actor.tenantId);
      try {
        return await merchantLessonService.approveDraft(
          actor,
          caseId,
          version,
          lessons?.service ?? null,
        );
      } finally {
        lessons?.close();
      }
    },
  );
  const requireCaseLesson = async (
    actor: Actor,
    caseId: string,
    lessonId: string,
  ) => {
    await tenantTransaction(pool, actor.tenantId, async (db) => {
      await authorizeOperator(db, actor);
      const lesson = await db.query(
        "SELECT 1 FROM morrow.lessons WHERE tenant_id=$1 AND case_id=$2 AND id=$3",
        [actor.tenantId, caseId, lessonId],
      );
      if (!lesson.rowCount) throw new DomainError("CASE_NOT_FOUND", 404);
    });
  };
  app.post("/api/v1/merchant/cases/:caseId/lesson", async (request) => {
    await requireMerchant(request as never);
    throw new DomainError("LESSON_DRAFT_REQUIRED", 409);
  });
  app.post(
    "/api/v1/merchant/cases/:caseId/lesson/:lessonId/advance",
    async (request) => {
      const actor = await requireMerchant(request as never);
      const caseId = (request.params as { caseId?: unknown }).caseId;
      const lessonId = (request.params as { lessonId?: unknown }).lessonId;
      if (
        typeof caseId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(caseId) ||
        typeof lessonId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(lessonId)
      )
        throw new DomainError("CASE_NOT_FOUND", 404);
      await requireCaseLesson(actor, caseId, lessonId);
      const lessons = lessonWire(actor.tenantId);
      if (!lessons) throw new DomainError("MEMORY_UNAVAILABLE", 503);
      try {
        return await lessons.service.advance(actor.tenantId, lessonId);
      } finally {
        lessons.close();
      }
    },
  );
  app.post(
    "/api/v1/merchant/cases/:caseId/lesson/:lessonId/recall",
    async (request) => {
      const actor = await requireMerchant(request as never);
      const caseId = (request.params as { caseId?: unknown }).caseId;
      const lessonId = (request.params as { lessonId?: unknown }).lessonId;
      if (
        typeof caseId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(caseId) ||
        typeof lessonId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(lessonId)
      )
        throw new DomainError("CASE_NOT_FOUND", 404);
      await requireCaseLesson(actor, caseId, lessonId);
      const lessons = lessonWire(actor.tenantId);
      if (!lessons) throw new DomainError("MEMORY_UNAVAILABLE", 503);
      try {
        const fresh = walrusGateway(lessons.tenantConfig);
        try {
          return await lessons.service.verifyRecall(
            actor.tenantId,
            lessonId,
            fresh,
          );
        } finally {
          fresh.close();
        }
      } finally {
        lessons.close();
      }
    },
  );

  app.post("/api/v1/merchant/cases/:caseId/fair", async (request) => {
    const actor = await requireMerchant(request as never);
    const caseId = (request.params as { caseId?: unknown }).caseId;
    if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
      throw new DomainError("CASE_NOT_FOUND", 404);
    const body = z
      .object({ mode: z.enum(["OFF", "ON"]) })
      .strict()
      .parse(request.body);
    if (!fair) throw new DomainError("FAIR_UNAVAILABLE", 503);
    return fair.run(actor, caseId, body.mode);
  });

  // ---- Existing demo operator routes (bearer session) ----
  app.register(
    async (routes) => {
      routes.addHook("onRequest", async (request) => {
        if (!options.demoEnabled)
          throw new DomainError("AUTHENTICATION_REQUIRED", 401);
        const match = request.headers.authorization?.match(
          /^Bearer ([A-Za-z0-9_-]{43})$/,
        );
        if (!match) throw new DomainError("AUTHENTICATION_REQUIRED", 401);
        const hash = createHash("sha256").update(match[1]!).digest("hex");
        const r = await pool.query(
          `UPDATE morrow.demo_sessions SET used_requests=used_requests+1
        WHERE token_hash=$1 AND expires_at>clock_timestamp() AND used_requests<max_requests
        RETURNING tenant_id,operator_id`,
          [hash],
        );
        const session = r.rows[0];
        request.morrowSessionHash = hash;
        if (!session) throw new DomainError("SESSION_UNAVAILABLE", 401);
        request.morrowActor = {
          tenantId: session.tenant_id,
          operatorId: session.operator_id,
          role: "judge",
        };
      });
      const params = z.object({ caseId: z.uuid() }).strict();
      const runKey = (request: { headers: Record<string, unknown> }) =>
        z.string().min(32).max(128).parse(request.headers["idempotency-key"]);
      const journey = () => {
        if (!options.demoJourney)
          throw new DomainError("DEMO_UNAVAILABLE", 503);
        return options.demoJourney;
      };
      routes.get("/demo/state", (request) =>
        journey().view(request.morrowActor!, runKey(request)),
      );
      routes.post("/demo/check", (request) =>
        journey().check(request.morrowActor!, runKey(request)),
      );
      routes.post("/demo/check-c", (request) =>
        journey().checkC(request.morrowActor!, runKey(request)),
      );
      routes.post("/demo/start-c", (request) =>
        journey().startC(request.morrowActor!, runKey(request)),
      );
      routes.get("/demo/proof", (request) =>
        journey().proof(request.morrowActor!, runKey(request)),
      );
      routes.post("/demo/investigate", (request) =>
        journey().propose(request.morrowActor!, runKey(request)),
      );
      routes.post("/demo/decision", (request) => {
        const body = z
          .object({
            kind: z.enum(["APPROVED", "REJECTED"]),
            caseVersion: z.number().int().positive(),
            policyVersion: z.number().int().positive(),
          })
          .strict()
          .parse(request.body);
        return journey().decide(request.morrowActor!, runKey(request), body);
      });
      routes.post("/demo/repair", (request) => {
        const body = z
          .object({ decisionId: z.uuid() })
          .strict()
          .parse(request.body);
        return journey().repair(
          request.morrowActor!,
          runKey(request),
          body.decisionId,
        );
      });
      routes.post("/demo/draft/open", (request) =>
        journey().openDraft(request.morrowActor!, runKey(request)),
      );
      routes.post("/demo/draft", (request) =>
        journey().saveDraft(
          request.morrowActor!,
          runKey(request),
          draftUpdateSchema.parse(request.body),
        ),
      );
      routes.post("/demo/lesson/approve", (request) => {
        const body = z
          .object({ version: z.number().int().positive() })
          .strict()
          .parse(request.body);
        return journey().approveLesson(
          request.morrowActor!,
          runKey(request),
          body.version,
        );
      });
      routes.post("/demo/lesson/retry", (request) =>
        journey().retryStorage(request.morrowActor!, runKey(request)),
      );
      for (const mode of ["OFF", "ON"] as const)
        routes.post("/demo/comparison/" + mode.toLowerCase(), (request) =>
          journey().compare(request.morrowActor!, runKey(request), mode),
        );
      routes.post("/demo/start-b", (request) =>
        journey().startB(request.morrowActor!, runKey(request)),
      );

      routes.get("/cases/:caseId", async (request) =>
        service.inspect(
          request.morrowActor!,
          params.parse(request.params).caseId,
        ),
      );
      routes.post("/cases/:caseId/investigations", async (request) => {
        if (request.body !== undefined)
          z.object({}).strict().parse(request.body);
        return service.investigate(
          request.morrowActor!,
          params.parse(request.params).caseId,
        );
      });
      routes.post("/cases/:caseId/recommendations", async (request) => {
        if (request.body !== undefined)
          z.object({ planner: z.string().optional() })
            .strict()
            .parse(request.body);
        const { caseId } = params.parse(request.params);
        const plannerName = (request.body as { planner?: string } | undefined)
          ?.planner;
        if (!investigation) throw new DomainError("AGENT_UNAVAILABLE", 503);
        return investigation.recommend(
          request.morrowActor!,
          caseId,
          plannerName,
        );
      });
      routes.post("/cases/:caseId/decisions", async (request, reply) => {
        const { caseId } = params.parse(request.params);
        const body = decisionRequestSchema.parse(request.body);
        return reply
          .code(201)
          .send(
            await service.decide(request.morrowActor!, { ...body, caseId }),
          );
      });
      routes.post("/cases/:caseId/repairs", async (request) => {
        const { caseId } = params.parse(request.params);
        const body = repairSchema.omit({ caseId: true }).parse(request.body);
        return service.repair(request.morrowActor!, { ...body, caseId });
      });
      routes.post("/cases/:caseId/fair", async (request) => {
        const { caseId } = params.parse(request.params);
        const body = z
          .object({ mode: z.enum(["OFF", "ON"]) })
          .strict()
          .parse(request.body);
        if (!fair) throw new DomainError("FAIR_UNAVAILABLE", 503);
        return fair.run(request.morrowActor!, caseId, body.mode);
      });
      routes.post("/demo/payments/:role", async (request) => {
        const { role } = z
          .object({ role: z.enum(["B", "C"]) })
          .parse(request.params);
        const key = z
          .string()
          .min(32)
          .max(128)
          .parse(request.headers["idempotency-key"]);
        if (role === "C") return journey().startC(request.morrowActor!, key);
        if (!provisioning)
          throw new DomainError("DEMO_PAYMENT_UNAVAILABLE", 503);
        return provisioning.prepare(request.morrowActor!, key, role, service);
      });
      routes.post("/cases/:caseId/comparisons", async (request) => {
        const { caseId } = params.parse(request.params);
        const body = z
          .object({ caseBId: z.uuid() })
          .strict()
          .parse(request.body);
        if (!fair) throw new DomainError("FAIR_UNAVAILABLE", 503);
        return fair.compare(request.morrowActor!, caseId, body.caseBId);
      });
      routes.get("/proof/simulations/:caseId", async (request) => {
        const { caseId } = params.parse(request.params);
        const actor = request.morrowActor!;
        return tenantTransaction(pool, actor.tenantId, async (db) => {
          await authorizeOperator(db, actor);
          const rows = await db.query(
            `SELECT data FROM morrow.case_events
             WHERE tenant_id=$1 AND case_id=$2 AND kind='SIMULATION_RUN' ORDER BY id`,
            [actor.tenantId, caseId],
          );
          return {
            runs: rows.rows.map((r) => {
              const data = (
                typeof r.data === "string" ? JSON.parse(r.data) : r.data
              ) as {
                mode?: string;
                plan?: Array<string>;
              };
              return {
                mode: data.mode,
                steps: Array.isArray(data.plan) ? data.plan.length : 0,
              };
            }),
          };
        });
      });
      routes.post("/demo/reset", async (request) => {
        const actor = request.morrowActor!;
        await tenantTransaction(pool, actor.tenantId, async (db) => {
          await authorizeOperator(db, actor);
          await db.query(
            "UPDATE morrow.demo_sessions SET used_requests=max_requests WHERE tenant_id=$1 AND operator_id=$2 AND token_hash=$3",
            [actor.tenantId, actor.operatorId, request.morrowSessionHash],
          );
        });
        return { ok: true };
      });
    },
    { prefix: "/api/v1" },
  );

  // ---- Static frontend (S4: /, /help, /help/case/:caseId; S5: /merchant/*; S11: /demo, /proof) ----
  if (options.staticDir) {
    const dir = options.staticDir;
    const serve = async (reply: FastifyReply, file: string) => {
      const ext = file.slice(file.lastIndexOf("."));
      const type = STATIC_TYPES[ext];
      if (!type || file.includes("..")) throw new DomainError("NOT_FOUND", 404);
      try {
        const data = await readFile(join(dir, file));
        return reply.type(type).send(data);
      } catch {
        throw new DomainError("NOT_FOUND", 404);
      }
    };
    app.get("/", (_request, reply) => serve(reply as never, "index.html"));
    app.get("/help", (_request, reply) => serve(reply as never, "help.html"));
    app.get("/help/case/:caseId", (request, reply) => {
      const caseId = (request.params as { caseId?: unknown }).caseId;
      if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
        throw new DomainError("CASE_NOT_FOUND", 404);
      return serve(reply as never, "case.html");
    });
    app.get("/merchant/login", (_request, reply) =>
      serve(reply as never, "merchant-login.html"),
    );
    app.get("/merchant/cases", (_request, reply) =>
      serve(reply as never, "merchant-cases.html"),
    );
    app.get("/merchant/lessons", (_request, reply) =>
      serve(reply as never, "merchant-lessons.html"),
    );
    app.get("/merchant/providers", (_request, reply) =>
      serve(reply as never, "merchant-providers.html"),
    );
    app.get("/merchant/cases/:caseId", (request, reply) => {
      const caseId = (request.params as { caseId?: unknown }).caseId;
      if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId))
        throw new DomainError("CASE_NOT_FOUND", 404);
      return serve(reply as never, "merchant-cases.html");
    });
    app.get("/demo", (_request, reply) => serve(reply as never, "demo.html"));
    app.get("/proof", (_request, reply) => serve(reply as never, "proof.html"));
    app.get("/assets/:name", (request, reply) => {
      const name = (request.params as { name?: unknown }).name;
      if (typeof name !== "string" || !/^[a-z0-9.-]+$/i.test(name))
        throw new DomainError("NOT_FOUND", 404);
      return serve(reply as never, name);
    });
  }
  return app;
}
declare module "fastify" {
  interface FastifyRequest {
    morrowActor?: Actor;
    morrowSessionHash?: string;
  }
}

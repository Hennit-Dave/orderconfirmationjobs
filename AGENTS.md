# AGENTS.md — Order Confirmation Email Jobs (Task 2)

This file is the single source of truth for this repo, same pattern as Task 1:
rules, schema, and the worker's core claim logic together in one file.

**Setup instruction for the agent:** extract the `prisma/schema.prisma` code
block below into its own file exactly as written. Do not redesign it.

## Domain
Background job system for one kind of work: sending an order confirmation
email via Nodemailer, over SMTP, through Mailtrap's free sandbox. This repo
is standalone — it does not depend on the freelance-marketplace-api repo,
it just simulates receiving an order.

Mailtrap is a testing sandbox: every email is caught and shown in a
dashboard, never actually delivered to a real inbox. That's deliberate —
it needs no domain verification and can send to any address, which is what
lets the trigger endpoint simulate different customers per order. It still
counts as sending through a real provider: it's a genuine network call to a
real external service, with real latency and real failure modes, same as
any other provider from the worker's point of view.

## No live deployment required
Every piece of evidence this task asks for (jobs table screenshot, backoff
timestamps, concurrency log, stuck-job recovery, dead letter view) is
captured running locally. Do not deploy this to Vercel. The API runs via
`npm run dev`, the worker runs separately via `tsx worker.ts` in its own
terminal, both on localhost.

## Non-negotiable conventions
- Every job is one row. Never do the actual work inside the request handler
  that enqueues it — the handler only ever writes a `pending` row and
  returns `202` immediately.
- `status` has five real values: `pending`, `processing`, `succeeded`,
  `failed`, `dead`. `failed` means it will retry. `dead` means retries are
  exhausted and it needs a human. Never conflate the two.
- The claim MUST be a single atomic SQL statement using
  `FOR UPDATE SKIP LOCKED` (see the worker query below). Never
  read-then-write in two separate statements — that's a race condition
  between workers, not a fix for one.
- Idempotency key is `order-confirmation:<orderId>`. If the same key
  arrives twice, return the existing job, never create a second one.
- Backoff on failure is exponential with jitter:
  `baseDelayMs * 2^attempts + random(0, jitterMs)`. Never a fixed delay —
  fixed delays mean every failed job retries at the exact same moment and
  hits the same failing dependency together.
- The worker must tolerate running the same job twice without sending a
  duplicate email. Before sending, check whether an email has already been
  sent for this order (e.g. a `sentAt` timestamp), not just whether the job
  row exists.
- A job stuck in `processing` for longer than a configured timeout gets
  swept back to `pending` with an incremented attempt count. Put the
  timeout in config, not hardcoded.
- Concurrency is capped at a configured number of jobs in flight at once.
  Put the number in config.

## Stack
- Next.js API routes for the enqueue endpoint and status endpoint
- Prisma + the same Neon Postgres database style as Task 1 (a fresh
  database for this repo, not the marketplace one)
- Nodemailer for sending, configured with Mailtrap's SMTP credentials —
  never the Resend SDK, this repo doesn't use Resend
- Plain Node/tsx script for the worker — no queue service, no Inngest

## Env vars
`.env` needs `DATABASE_URL`, `DIRECT_URL` (same Neon pattern as Task 1),
plus Mailtrap's SMTP credentials: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`. All four SMTP values come from the Mailtrap inbox's SMTP
Settings page after signup — no domain of your own required.

## Traps — check for these before considering a task done
- Doing the email send inside the enqueue request handler and calling it a
  job.
- Retrying forever with no `dead` state.
- Fixed retry delays with no jitter.
- A claim that reads then writes in two statements.
- A worker that crashes mid-job and leaves it in `processing` forever with
  no sweep.
- Sending the same confirmation email twice because a job ran twice after a
  crash.

## Endpoints
- `POST /api/orders` — body: `{ orderId, recipientEmail, recipientName,
  gigTitle, priceMinor, currency }`. Writes a `pending` job, returns `202`
  with the job id. Idempotent on `orderId`.
- `GET /api/jobs/:id` — returns status, attempts, and lastError if any.
- `GET /dead-letters` — minimal page listing `dead` jobs with payload and
  lastError, and a retry button per job that resets it to `pending` with
  `attempts: 0`.

---

## `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

enum JobStatus {
  pending
  processing
  succeeded
  failed
  dead
}

model Job {
  id             String    @id @default(cuid())
  type           String
  payload        Json
  status         JobStatus @default(pending)
  attempts       Int       @default(0)
  maxAttempts    Int       @default(5)
  lastError      String?
  runAt          DateTime  @default(now())
  startedAt      DateTime?
  finishedAt     DateTime?
  sentAt         DateTime? // set only after the email genuinely sends; the idempotency guard for the actual side effect
  idempotencyKey String    @unique
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([status, runAt])
}
```

## Worker's atomic claim (the core of worker.ts)

```typescript
// A single statement: locks one eligible row, skips rows other workers
// already have locked, and marks it processing — all atomically.
const [job] = await prisma.$queryRaw<Job[]>`
  UPDATE "Job"
  SET status = 'processing', "startedAt" = now(), attempts = attempts + 1
  WHERE id = (
    SELECT id FROM "Job"
    WHERE status = 'pending' AND "runAt" <= now()
    ORDER BY "runAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
`;
```

## Sending the email (the core of the send step in worker.ts)

```typescript
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Idempotency guard for the actual side effect, not just the job row —
// see the sentAt field on Job. Check this before calling sendMail.
await transporter.sendMail({
  from: 'orders@freelance-marketplace.test',
  to: payload.recipientEmail,
  subject: `Order confirmation — ${payload.gigTitle}`,
  text: `Thanks for your order! ${payload.gigTitle} — ${(payload.priceMinor / 100).toFixed(2)} ${payload.currency}`,
});
// On success, set sentAt = now() alongside status = 'succeeded'.
```

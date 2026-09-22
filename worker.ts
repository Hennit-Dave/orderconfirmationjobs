import { PrismaClient, Job } from '@prisma/client';
import nodemailer from 'nodemailer';
import type { OrderPayload } from './src/lib/types';

const prisma = new PrismaClient();

const POLL_INTERVAL_MS = 1000;

// Exponential backoff: baseDelayMs * 2^attempts + random(0, jitterMs).
// Mailtrap's sandbox round-trip is ~5.5s, so baseDelayMs is kept on the
// order of a couple of seconds — otherwise retries would fire tighter
// than a real send attempt actually takes.
const BASE_DELAY_MS = 2000;
const JITTER_MS = 1000;

// A job stuck in 'processing' longer than this (worker crashed mid-job,
// killed, etc.) gets swept back to 'pending' so it can be retried.
const STUCK_TIMEOUT_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

// Maximum number of jobs this worker will have claimed and in-flight at once.
const MAX_CONCURRENT_JOBS = 3;

let inFlight = 0;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// A single statement: locks one eligible row, skips rows other workers
// already have locked, and marks it processing — all atomically. Eligible
// jobs are 'pending' (never tried) or 'failed' (waiting out its backoff
// delay) — either way, once runAt has passed it's fair game.
async function claimJob(): Promise<Job | null> {
  const [job] = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
    SET status = 'processing', "startedAt" = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "Job"
      WHERE (status = 'pending' OR status = 'failed') AND "runAt" <= now()
      ORDER BY "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;
  return job ?? null;
}

// Single atomic statement, same spirit as the claim query: reset every job
// that's been stuck in 'processing' past the timeout back to 'pending',
// incrementing attempts like a normal failure — not a fresh attempt count —
// so a job that keeps getting stuck still eventually reaches maxAttempts.
async function sweepStuckJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS);
  const swept = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
    SET status = 'pending', attempts = attempts + 1
    WHERE status = 'processing' AND "startedAt" < ${cutoff}
    RETURNING *;
  `;

  for (const job of swept) {
    console.log(`swept stuck job ${job.id} back to pending (attempt ${job.attempts})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendConfirmationEmail(payload: OrderPayload): Promise<void> {
  // Testing-only escape hatch for exercising the failure/backoff/dead path
  // without depending on Mailtrap actually rejecting anything — never set
  // this in production.
  if (process.env.FORCE_SEND_FAILURE === 'true') {
    throw new Error('FORCE_SEND_FAILURE is set — simulated send failure');
  }

  await transporter.sendMail({
    from: 'orders@freelance-marketplace.test',
    to: payload.recipientEmail,
    subject: `Order confirmation — ${payload.gigTitle}`,
    text: `Thanks for your order! ${payload.gigTitle} — ${(payload.priceMinor / 100).toFixed(2)} ${payload.currency}`,
  });
}

async function handleFailure(job: Job, message: string): Promise<void> {
  if (job.attempts >= job.maxAttempts) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'dead', lastError: message, finishedAt: new Date() },
    });
    console.log(`job ${job.id} exhausted ${job.attempts}/${job.maxAttempts} attempts, marked dead`);
    return;
  }

  const delayMs = BASE_DELAY_MS * 2 ** job.attempts + Math.random() * JITTER_MS;
  const runAt = new Date(Date.now() + delayMs);

  await prisma.job.update({
    where: { id: job.id },
    data: { status: 'failed', lastError: message, runAt },
  });

  console.log(`job ${job.id} will retry at ${runAt.toISOString()} (attempt ${job.attempts}/${job.maxAttempts})`);
}

async function processJob(job: Job): Promise<void> {
  const payload = job.payload as unknown as OrderPayload;

  // Idempotency guard for the actual side effect, not just the job row:
  // if this order's email already went out (e.g. a prior run crashed after
  // sending but before this update), don't send it again.
  if (job.sentAt === null) {
    try {
      await sendConfirmationEmail(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`job ${job.id} send failed:`, message);
      await handleFailure(job, message);
      return;
    }
  } else {
    console.log(`job ${job.id} already sent at ${job.sentAt.toISOString()}, skipping resend`);
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'succeeded',
      finishedAt: new Date(),
      ...(job.sentAt === null ? { sentAt: new Date() } : {}),
    },
  });

  console.log(`job ${job.id} marked succeeded`);
}

// One lane = one claim-process-claim loop. Running MAX_CONCURRENT_JOBS
// lanes in parallel is what caps total in-flight jobs at that number —
// each lane holds at most one job at a time, and claimJob's SKIP LOCKED
// means concurrent lanes never race each other for the same row.
async function workerLane(): Promise<void> {
  for (;;) {
    const job = await claimJob();

    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    inFlight++;
    console.log(`claimed job ${job.id} (attempt ${job.attempts}) — in-flight: ${inFlight}/${MAX_CONCURRENT_JOBS}`);

    await processJob(job);

    inFlight--;
    console.log(`completed job ${job.id} — in-flight: ${inFlight}/${MAX_CONCURRENT_JOBS}`);
  }
}

async function runLoop(): Promise<void> {
  console.log('worker started, polling for jobs...');

  await sweepStuckJobs();
  setInterval(() => {
    sweepStuckJobs().catch((err) => console.error('stuck-job sweep failed:', err));
  }, SWEEP_INTERVAL_MS);

  console.log(`running with ${MAX_CONCURRENT_JOBS} concurrent lane(s)`);
  await Promise.all(Array.from({ length: MAX_CONCURRENT_JOBS }, () => workerLane()));
}

runLoop().catch((err) => {
  console.error('worker crashed:', err);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

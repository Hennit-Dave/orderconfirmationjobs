import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { OrderPayload } from '@/lib/types';

type ValidationResult =
  | { valid: true; data: OrderPayload }
  | { valid: false; error: string };

function validatePayload(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const { orderId, recipientEmail, recipientName, gigTitle, priceMinor, currency } =
    body as Record<string, unknown>;

  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return { valid: false, error: 'orderId is required and must be a string' };
  }
  if (typeof recipientEmail !== 'string' || recipientEmail.trim() === '') {
    return { valid: false, error: 'recipientEmail is required and must be a string' };
  }
  if (typeof recipientName !== 'string' || recipientName.trim() === '') {
    return { valid: false, error: 'recipientName is required and must be a string' };
  }
  if (typeof gigTitle !== 'string' || gigTitle.trim() === '') {
    return { valid: false, error: 'gigTitle is required and must be a string' };
  }
  if (typeof priceMinor !== 'number' || !Number.isInteger(priceMinor) || priceMinor <= 0) {
    return { valid: false, error: 'priceMinor is required and must be a non-negative integer' };
  }
  if (typeof currency !== 'string' || currency.trim() === '') {
    return { valid: false, error: 'currency is required and must be a string' };
  }

  return {
    valid: true,
    data: { orderId, recipientEmail, recipientName, gigTitle, priceMinor, currency },
  };
}

// Writes a pending job row and returns immediately. The actual email send
// happens later in worker.ts — never do that work here.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const result = validatePayload(body);
  if (!result.valid) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const { data } = result;
  const idempotencyKey = `order-confirmation:${data.orderId}:${Date.now()}`;

  try {
    const job = await prisma.job.create({
      data: {
        type: 'order-confirmation',
        payload: data,
        idempotencyKey,
      },
    });

    return NextResponse.json({ id: job.id, status: job.status }, { status: 202 });
  } catch (err) {
    // Unique constraint on idempotencyKey means this orderId was already
    // enqueued — return the existing job instead of creating a second one.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2001') {
      const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
      if (existing) {
        return NextResponse.json({ id: existing.id, status: existing.status }, { status: 202 });
      }
    }
    throw err;
  }
}

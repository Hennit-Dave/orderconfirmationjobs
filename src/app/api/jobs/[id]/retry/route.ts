import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// Backs the retry button on /dead-letters. Resets a dead (or any) job back
// to a fresh pending state so the worker's normal claim loop picks it up.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await prisma.job.update({
      where: { id: params.id },
      data: {
        status: 'pending',
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        runAt: new Date(),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.redirect(new URL('/dead-letters', request.url), { status: 303 });
}

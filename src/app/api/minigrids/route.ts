// app/api/minigrids/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();

    const run = await prisma.miniGridRun.create({
      data: {
        userId: session.user.id,
        name: body.name || null,
        fileName: body.fileName || null,
        dataPoints: body.dataPoints,
        mstNodes: body.mstNodes,
        mstEdges: body.mstEdges,
        costBreakdown: body.costBreakdown,
        poleCost: body.poleCost,
        lowVoltageCost: body.lowVoltageCost,
        highVoltageCost: body.highVoltageCost,
      },
    });

    return NextResponse.json({ success: true, id: run.id });
  } catch (err) {
    console.error('[POST /api/minigrids]', err);
    return NextResponse.json(
      { error: 'Failed to save mini-grid' },
      { status: 500 }
    );
  }
}

// ────────────────────────────────────────────────
// Add this GET handler to allow fetching the list
// ────────────────────────────────────────────────
export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const runs = await prisma.miniGridRun.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        createdAt: 'desc', // newest first
      },
    });

    return NextResponse.json(runs);
  } catch (err) {
    console.error('[GET /api/minigrids]', err);
    return NextResponse.json(
      { error: 'Failed to fetch saved runs' },
      { status: 500 }
    );
  }
}

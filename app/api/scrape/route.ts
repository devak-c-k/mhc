import { NextRequest, NextResponse } from 'next/server';
import { scrapeStatus } from '@/lib/scraper';

export const maxDuration = 500; // Allow 500s for scraper (Vercel limit)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { cnrs } = body;

    if (!cnrs || !Array.isArray(cnrs) || cnrs.length === 0) {
      return NextResponse.json({ error: 'CNRs must be an array' }, { status: 400 });
    }

    const results = [];

    // Process sequentially to avoid Playwright resource issues on small instances
    // Parallel updates would require launching multiple browsers
    for (const cnr of cnrs) {
      // Small random delay
      if (results.length > 0) await new Promise(r => setTimeout(r, 1000));
      
      try {
        const result = await scrapeStatus(cnr.trim());
        results.push({ cnr: cnr.trim(), ...result });
      } catch (e: any) {
        results.push({ cnr: cnr.trim(), success: false, error: e.message });
      }
    }

    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('[API Error]', error);
    return NextResponse.json({ 
        error: error.message || 'An unexpected error occurred',
        stack: error.stack,
        details: JSON.stringify(error)
    }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as os from 'os';

// Dev-only endpoint — returns CLI wallet bytes for local testing.
// Blocked in production; never ship this to a public host.
export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 });
  }
  try {
    const raw: number[] = JSON.parse(
      fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf-8'),
    );
    return NextResponse.json({ bytes: raw });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

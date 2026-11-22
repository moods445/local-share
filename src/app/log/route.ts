import { ClientLogHandler } from '@/lib/server/client-log';
import { logger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

/**
 * 前端埋点接收。线上构建可设 TELEMETRY_ENABLED=0 直接关闭，
 * 前端也会用 NEXT_PUBLIC_TELEMETRY_ENABLED=0 停止上报。
 */
const enabled = process.env.TELEMETRY_ENABLED !== '0';
const handler = new ClientLogHandler(logger, process.env.TRUST_PROXY === '1');

export async function POST(request: Request): Promise<Response> {
  if (!enabled) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  return handler.handle(request);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
    },
  });
}

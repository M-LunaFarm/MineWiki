export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    status: 'ok',
    service: 'minewiki-web',
    timestamp: new Date().toISOString(),
  });
}

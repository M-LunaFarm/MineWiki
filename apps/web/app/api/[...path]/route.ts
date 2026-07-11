import type { NextRequest } from 'next/server';
import { buildApiTargetUrl } from '../../../lib/api-proxy-target.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ path: string[] }>;
}

const HOP_BY_HOP_HEADERS = [
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
];

function resolveApiBaseUrl(): URL {
  const configured = process.env.INTERNAL_API_BASE_URL?.trim() || 'http://127.0.0.1:3000';
  const url = new URL(configured);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('INTERNAL_API_BASE_URL must use http or https.');
  }
  return url;
}

function buildTargetUrl(request: NextRequest, path: readonly string[]): URL {
  return buildApiTargetUrl(resolveApiBaseUrl(), path, request.nextUrl.search);
}

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const { path } = await context.params;
    const headers = new Headers(request.headers);
    for (const header of HOP_BY_HOP_HEADERS) {
      headers.delete(header);
    }
    headers.delete('host');

    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
    const upstream = await fetch(buildTargetUrl(request, path), {
      method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
    });

    const responseHeaders = new Headers(upstream.headers);
    for (const header of HOP_BY_HOP_HEADERS) {
      responseHeaders.delete(header);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('API proxy request failed', error);
    return Response.json(
      { statusCode: 502, error: 'Bad Gateway', message: 'API service is unavailable.' },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;

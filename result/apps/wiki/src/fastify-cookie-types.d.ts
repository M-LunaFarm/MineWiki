import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    cookies?: Record<string, string>;
    unsignCookie(value: string): { valid: boolean; renew: boolean; value: string | null };
  }

  interface FastifyReply {
    setCookie(name: string, value: string, options?: Record<string, unknown>): this;
    clearCookie(name: string, options?: Record<string, unknown>): this;
  }
}

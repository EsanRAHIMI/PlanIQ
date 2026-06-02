import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

/** Uniform error envelope: { error: { code, message, details?, traceId } }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const traceId = req.id ?? randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Unexpected error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      message = typeof r === 'string' ? r : r.message ?? message;
      code = r.code ?? httpCode(status);
      details = Array.isArray(r.message) ? r.message : r.details;
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status >= 500) this.logger.error({ traceId, err: exception }, message);

    res.status(status).json({ error: { code, message, details, traceId } });
  }
}

function httpCode(status: number): string {
  return ({
    400: 'VALIDATION_ERROR', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
    404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE',
    422: 'UNPROCESSABLE', 429: 'RATE_LIMITED',
  } as Record<number, string>)[status] ?? 'ERROR';
}

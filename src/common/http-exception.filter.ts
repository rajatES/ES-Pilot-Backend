import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";

// The original Next.js routes returned errors as `{ error: "<message>" }` with a
// specific HTTP status. NestJS's default envelope is `{ statusCode, message, error }`,
// which would break every frontend call that reads `data.error`. This filter keeps
// the original contract: any thrown HttpException (or unexpected error) is rendered
// as `{ error: "<message>" }` with the right status.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpException");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "Internal server error";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else if (body && typeof body === "object") {
        const m = (body as any).message;
        message = Array.isArray(m) ? m.join(", ") : m || (body as any).error || message;
      }
    } else if (exception instanceof Error) {
      message = exception.message || message;
      this.logger.error(exception.stack || exception.message);
    }

    res.status(status).json({ error: message });
  }
}

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { ApiErrorResponse } from "@polymarket-copy/shared";

interface ResponseWithJson {
  status(code: number): {
    json(body: ApiErrorResponse): void;
  };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<ResponseWithJson>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_SERVER_ERROR";
    let message = "Une erreur interne est survenue sur le serveur";
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = exception.name;
      const res = exception.getResponse();
      if (typeof res === "string") {
        message = res;
      } else if (typeof res === "object" && res !== null) {
        const obj = res as Record<string, unknown>;
        if (typeof obj.message === "string") {
          message = obj.message;
        }
        if (obj.details !== undefined) {
          details = obj.details;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      code = exception.name || "Error";
    }

    const payload: ApiErrorResponse = {
      success: false,
      error: {
        code,
        message,
        details,
      },
    };

    response.status(status).json(payload);
  }
}

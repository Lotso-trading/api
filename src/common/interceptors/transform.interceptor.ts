import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { ApiSuccessResponse } from "@polymarket-copy/shared";
import type { Observable } from "rxjs";
import { map } from "rxjs";

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T>> {
    return next.handle().pipe(
      map((data: T) => ({
        success: true,
        data,
      }))
    );
  }
}

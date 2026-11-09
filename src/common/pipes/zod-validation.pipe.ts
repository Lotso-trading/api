import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodIssue, ZodSchema } from "zod";

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const formattedErrors = result.error.issues.map((err: ZodIssue) => ({
        path: err.path.join("."),
        message: err.message,
      }));
      throw new BadRequestException({
        message: "Erreur de validation des données d'entrée",
        details: formattedErrors,
      });
    }
    return result.data;
  }
}

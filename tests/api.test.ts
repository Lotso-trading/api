import { assertEquals, assertThrows } from "jsr:@std/assert";
import { BadRequestException, type ExecutionContext } from "@nestjs/common";
import { AddTargetInputSchema } from "@polymarket-copy/shared";
import { of } from "rxjs";
import { TransformInterceptor } from "../src/common/interceptors/transform.interceptor.ts";
import { ZodValidationPipe } from "../src/common/pipes/zod-validation.pipe.ts";

Deno.test("ZodValidationPipe - valide et transforme une entrée conforme", () => {
  const pipe = new ZodValidationPipe(AddTargetInputSchema);
  const rawInput = {
    address: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    alias: "Whale Test",
  };

  const result = pipe.transform(rawInput);
  assertEquals(result.alias, "Whale Test");
  assertEquals(result.address, rawInput.address.toLowerCase());
  assertEquals(result.enabled, true);
  assertEquals(result.weightMultiplier, 1.0);
});

Deno.test("ZodValidationPipe - rejette une entrée non conforme avec BadRequestException", () => {
  const pipe = new ZodValidationPipe(AddTargetInputSchema);
  const invalidInput = {
    address: "not-an-address",
    alias: "",
  };

  assertThrows(() => pipe.transform(invalidInput), BadRequestException);
});

Deno.test("TransformInterceptor - encapsule la réponse avec success: true", async () => {
  const interceptor = new TransformInterceptor<{ message: string }>();
  const mockCallHandler = {
    handle: () => of({ message: "hello" }),
  };
  const mockContext = {} as ExecutionContext;

  const result$ = interceptor.intercept(mockContext, mockCallHandler);

  await new Promise<void>((resolve) => {
    result$.subscribe((val) => {
      assertEquals(val.success, true);
      assertEquals(val.data.message, "hello");
      resolve();
    });
  });
});

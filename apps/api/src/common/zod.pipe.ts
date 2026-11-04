import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** Validates and coerces a body/query with a shared Zod schema. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        details: { issues: result.error.issues },
      });
    }
    return result.data;
  }
}

export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException({ code: 'INVALID_ID', message: `"${value}" is not a UUID` });
    }
    return value.toLowerCase();
  }
}

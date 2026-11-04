import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** OpenAPI body schema derived from the same Zod schema that validates the request. */
export const zodBody = (schema: ZodTypeAny) =>
  ({ schema: zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown> });

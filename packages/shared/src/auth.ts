import { z } from 'zod';

export const CreateServiceClientSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Machine role the client acts as. */
  role: z.enum(['discovery_service']).default('discovery_service'),
  /** Optional hard expiry for the client itself (tokens are always short-lived). */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateServiceClientInput = z.infer<typeof CreateServiceClientSchema>;

/** OAuth2 client-credentials style; JSON body. */
export const TokenRequestSchema = z.object({
  grantType: z.literal('client_credentials').default('client_credentials'),
  clientId: z.string().uuid(),
  clientSecret: z.string().min(10).max(200),
});
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export interface TokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

/** Access tokens for machine clients live this long. */
export const SERVICE_TOKEN_TTL_SECONDS = 900;

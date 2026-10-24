import type { AuthTokenApi } from './gemini';

// Ephemeral Gemini Live tokens for the "direct" coach transport: the headset connects to Google
// itself with a short-lived token instead of going through the relay.

export interface MintedToken {
  /** e.g. "auth_tokens/…": pass it as the SDK apiKey (Live API, v1alpha). */
  token: string;
  /** When the token stops working inside a session (ISO). New sessions must open within 60 s. */
  expiresAt: string;
}

export interface TokenMinter {
  mint(model: string): Promise<MintedToken>;
}

const SESSION_MS = 30 * 60_000;
const NEW_SESSION_MS = 60_000;

export function createGeminiTokenMinter(
  ai: AuthTokenApi,
  now: () => Date = () => new Date(),
): TokenMinter {
  return {
    // The model is not baked into the token: the browser sends its own Live config.
    async mint(_model) {
      const t = now().getTime();
      const expireTime = new Date(t + SESSION_MS).toISOString();
      const token = await ai.authTokens.create({
        config: {
          uses: 1,
          expireTime,
          newSessionExpireTime: new Date(t + NEW_SESSION_MS).toISOString(),
        },
      });
      if (!token.name) throw new Error('Gemini returned no token name');
      return { token: token.name, expiresAt: expireTime };
    },
  };
}

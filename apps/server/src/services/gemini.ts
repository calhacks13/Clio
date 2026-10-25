import {
  type AuthToken,
  type CreateAuthTokenParameters,
  type GenerateContentConfig,
  type GenerateContentParameters,
  GoogleGenAI,
  type ListModelsParameters,
  type Model,
  ThinkingLevel,
} from '@google/genai';

// The slice of the @google/genai client the server uses, as plain interfaces: services depend on
// these, so tests pass small fakes instead of a network client.

export interface AuthTokenApi {
  authTokens: { create(params: CreateAuthTokenParameters): Promise<AuthToken> };
}

export interface GenerateContentApi {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{ text?: string | undefined }>;
  };
}

export interface ModelListApi {
  models: { list(params?: ListModelsParameters): Promise<AsyncIterable<Model>> };
}

export type GeminiClient = AuthTokenApi & GenerateContentApi & ModelListApi;

export function isGeminiConfigured(apiKey: string | null | undefined): apiKey is string {
  return typeof apiKey === 'string' && apiKey.trim() !== '';
}

/** The default API version (v1beta) is used for both REST calls and token minting. */
export function createGeminiClient(apiKey: string): GeminiClient {
  return new GoogleGenAI({ apiKey, vertexai: false });
}

/** A call that ran past its deadline, so a route can answer 504 rather than 502. */
export class GeminiTimeoutError extends Error {
  override name = 'GeminiTimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`Gemini did not answer within ${Math.round(timeoutMs / 1000)} s`);
  }
}

export type Thinking = 'minimal' | 'low' | 'medium' | 'high';

const LEVELS: Record<Thinking, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Thinking for one call, by level. Gemini 3 models (Robotics-ER 2 among them) take a level;
 * older ones only a token budget, so they keep their own default rather than get a 400.
 * Measured on Robotics-ER 2 (docs/robotics-er.md): pointing, boxes and yes/no state are as
 * accurate at minimal (about 1 to 1.5 s) as at high; plans need low or more.
 */
export function thinkingConfig(
  model: string,
  level: Thinking,
): Pick<GenerateContentConfig, 'thinkingConfig'> {
  return /^gemini-(robotics-er-2|[3-9])/.test(model)
    ? { thinkingConfig: { thinkingLevel: LEVELS[level] } }
    : {};
}

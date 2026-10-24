import {
  type AuthToken,
  type CreateAuthTokenParameters,
  type GenerateContentParameters,
  GoogleGenAI,
  type ListModelsParameters,
  type Model,
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

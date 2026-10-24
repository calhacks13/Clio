import { COACH_TOOLS, type CoachToolName, toolParametersJsonSchema } from '@clio/protocol';
import { Behavior, type FunctionDeclaration, type Schema, type Tool, Type } from '@google/genai';

// Converts the protocol's tool definitions (zod → JSON Schema) into Gemini function declarations.
// Gemini's Live docs use the OpenAPI-style `parameters` field, so we convert rather than relying on
// `parametersJsonSchema`.

/** Tools that take seconds (planning). They run while the conversation continues. */
const NON_BLOCKING = new Set<CoachToolName>(['start_lesson', 'revise_plan']);

interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

const TYPES: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

function toSchema(node: JsonSchemaNode): Schema {
  const schema: Schema = { type: TYPES[node.type ?? 'string'] ?? Type.STRING };
  if (node.description) schema.description = node.description;
  if (node.enum) schema.enum = node.enum.map(String);
  if (node.items) schema.items = toSchema(node.items);
  if (node.properties) {
    schema.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, child]) => [key, toSchema(child)]),
    );
  }
  if (node.required?.length) schema.required = [...node.required];
  return schema;
}

export function toGeminiTools(names: readonly CoachToolName[]): Tool[] {
  const functionDeclarations: FunctionDeclaration[] = names.map((name) => ({
    name,
    description: COACH_TOOLS[name].description,
    behavior: NON_BLOCKING.has(name) ? Behavior.NON_BLOCKING : Behavior.BLOCKING,
    parameters: toSchema(toolParametersJsonSchema(name) as JsonSchemaNode),
  }));
  return [{ functionDeclarations }];
}

export const isNonBlocking = (name: string): boolean => NON_BLOCKING.has(name as CoachToolName);

import {
  COACH_TOOLS,
  type CoachToolName,
  isNonBlockingTool,
  toolParametersJsonSchema,
} from '@clio/protocol';
import { Behavior, type FunctionDeclaration, type Schema, type Tool, Type } from '@google/genai';

// Converts the protocol's tool definitions (zod → JSON Schema) into Gemini function declarations.
// Gemini's Live docs use the OpenAPI-style `parameters` field, so we convert rather than relying on
// `parametersJsonSchema`. Tools are blocking: each answers in milliseconds, and slow work
// (planning) reports back later as an [app] message. The exception is NON_BLOCKING: look_closer
// asks the smart model, and the voice keeps talking until the answer arrives (measured on
// gemini-3.8-live: it says its filler, calls, and speaks a WHEN_IDLE answer once it is idle).

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
    behavior: isNonBlockingTool(name) ? Behavior.NON_BLOCKING : Behavior.BLOCKING,
    parameters: toSchema(toolParametersJsonSchema(name) as JsonSchemaNode),
  }));
  return [{ functionDeclarations }];
}

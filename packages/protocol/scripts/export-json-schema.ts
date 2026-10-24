// Writes packages/protocol/schema/*.schema.json from the zod sources. Run `pnpm gen:schema` after
// changing any schema; a test fails if the committed files are stale.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildJsonSchemas } from '../src/json-schema';

const outDir = join(import.meta.dirname, '..', 'schema');
await mkdir(outDir, { recursive: true });

for (const [file, schema] of Object.entries(buildJsonSchemas())) {
  await writeFile(join(outDir, file), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schema/${file}`);
}

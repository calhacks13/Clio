import { z } from 'zod';
import { DemoClipSchema } from './clip';
import {
  BodyDocSchema,
  CompileManifestSchema,
  EnvironmentDocSchema,
  RetargetDocSchema,
  ShapesDocSchema,
  TracksDocSchema,
} from './derived';
import {
  EpisodeBatchSchema,
  EpisodeEventSchema,
  EpisodeFinishSchema,
  EpisodeMetaSchema,
  FrameRecordSchema,
  ObjectObservationSchema,
  ObjectTrackRecordSchema,
} from './episode';
import { ProcedureSchema } from './procedure';

// JSON Schema exports for non-TypeScript consumers (pipeline/). Procedures are authored by hand,
// so they use the *input* shape (defaults optional). Episode files are written by the app, so they
// use the *output* shape (every field present). Cross-reference rules (e.g. unknown object ids)
// are not expressible in JSON Schema; TypeScript enforces them via `parseProcedure`.

const BASE_ID = 'https://clio.dev/schema/';

function exportSchema(
  file: string,
  title: string,
  schema: z.ZodType,
  io: 'input' | 'output',
): [string, object] {
  const json = z.toJSONSchema(schema, { io, target: 'draft-2020-12' }) as Record<string, unknown>;
  return [file, { ...json, $id: BASE_ID + file, title }];
}

export function buildJsonSchemas(): Record<string, object> {
  return Object.fromEntries([
    exportSchema('procedure.schema.json', 'Clio procedure', ProcedureSchema, 'input'),
    exportSchema('episode-meta.schema.json', 'Clio episode meta.json', EpisodeMetaSchema, 'output'),
    exportSchema(
      'frame-record.schema.json',
      'Clio frames.ndjson line',
      FrameRecordSchema,
      'output',
    ),
    exportSchema(
      'episode-event.schema.json',
      'Clio events.ndjson line',
      EpisodeEventSchema,
      'output',
    ),
    exportSchema(
      'object-track.schema.json',
      'Clio objects.ndjson line',
      ObjectTrackRecordSchema,
      'output',
    ),
    exportSchema(
      'object-observation.schema.json',
      'Clio observations.ndjson line',
      ObjectObservationSchema,
      'output',
    ),
    exportSchema('episode-batch.schema.json', 'Clio episode batch', EpisodeBatchSchema, 'output'),
    exportSchema('episode-finish.schema.json', 'Clio finish.json', EpisodeFinishSchema, 'output'),
    exportSchema('demo-clip.schema.json', 'Clio demo clip', DemoClipSchema, 'output'),
    exportSchema(
      'derived-manifest.schema.json',
      'Clio compiled manifest.json',
      CompileManifestSchema,
      'output',
    ),
    exportSchema(
      'derived-tracks.schema.json',
      'Clio compiled tracks.json',
      TracksDocSchema,
      'output',
    ),
    exportSchema(
      'derived-environment.schema.json',
      'Clio compiled environment.json',
      EnvironmentDocSchema,
      'output',
    ),
    exportSchema(
      'derived-shapes.schema.json',
      'Clio compiled shapes.json',
      ShapesDocSchema,
      'output',
    ),
    exportSchema(
      'derived-retarget.schema.json',
      'Clio compiled retarget-<profile>.json',
      RetargetDocSchema,
      'output',
    ),
    exportSchema('derived-body.schema.json', 'Clio compiled body-g1.json', BodyDocSchema, 'output'),
  ]);
}

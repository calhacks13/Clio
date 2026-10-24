import { z } from 'zod';
import { Pose7Schema, Vec3Schema } from './geometry';
import { HAND_JOINTS, HandednessSchema, HandSampleSchema, JOINT_FIELDS } from './hand';

// An episode is one lesson run in one workspace frame. See docs/data-format.md for the on-disk
// layout (meta.json, frames.ndjson, events.ndjson) and the meaning of every field.

export const EPISODE_SCHEMA_ID = 'clio.episode/1';

export const EpisodeModeSchema = z.enum(['learn', 'record_demo', 'free']);
export const CalibrationMethodSchema = z.enum([
  'pinch_two_corners',
  'persisted_anchor',
  'default_in_front',
  'none',
]);
export const PlacementMethodSchema = z.enum(['layout', 'pinch', 'detector', 'manual']);
export const CoachKindSchema = z.enum(['gemini', 'scripted', 'none']);

export const PlacedObjectSchema = z.object({
  id: z.string(),
  label: z.string(),
  position: Vec3Schema,
  radius: z.number().positive(),
  method: PlacementMethodSchema,
});

export const EpisodeMetaSchema = z.object({
  schema: z.literal(EPISODE_SCHEMA_ID),
  episodeId: z.string(),
  createdAt: z.iso.datetime(),
  mode: EpisodeModeSchema,
  procedure: z.object({ id: z.string(), version: z.number().int(), title: z.string() }).nullable(),
  operator: z.object({
    role: z.enum(['learner', 'expert', 'collector']),
    id: z.string().optional(),
  }),
  clock: z.object({
    timeline: z.literal('performance.now'),
    startEpochMs: z.number().describe('Wall-clock ms at t = 0'),
  }),
  space: z.object({
    frame: z.literal('workspace'),
    units: z.literal('m'),
    upAxis: z.literal('+y'),
    worldFromWorkspace: Pose7Schema.describe('Workspace pose in WebXR local-floor space'),
    calibration: CalibrationMethodSchema,
    anchored: z.boolean().describe('Workspace pose tracked by a WebXR anchor'),
  }),
  hands: z.object({
    joints: z.array(z.string()).describe('Joint order used by HandSample.joints'),
    jointFields: z.array(z.string()).describe('Values per joint'),
  }),
  objects: z.array(PlacedObjectSchema).describe('Object placements when the episode started'),
  coach: z.object({
    kind: CoachKindSchema,
    model: z.string().optional(),
    transport: z.enum(['relay', 'direct']).optional(),
  }),
  device: z.object({
    userAgent: z.string(),
    emulated: z.boolean(),
    xrFeatures: z.array(z.string()),
  }),
  app: z.object({ version: z.string() }),
});

/** What the headset sends; the server assigns `episodeId` and `createdAt`. */
export const EpisodeCreateSchema = EpisodeMetaSchema.omit({ episodeId: true, createdAt: true });

/** Self-describing hand layout to embed in EpisodeMeta.hands. */
export const HAND_LAYOUT = { joints: [...HAND_JOINTS], jointFields: [...JOINT_FIELDS] };

export const FrameRecordSchema = z.object({
  t: z.number().nonnegative().describe('ms since episode start'),
  head: Pose7Schema.describe('Viewer pose, workspace frame'),
  left: HandSampleSchema.nullable(),
  right: HandSampleSchema.nullable(),
});

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ t: z.number().nonnegative(), type: z.literal(type), ...shape });

const stepRef = { stepId: z.string(), index: z.number().int().nonnegative() };

export const EpisodeEventSchema = z.discriminatedUnion('type', [
  event('procedure.started', {
    procedureId: z.string(),
    version: z.number().int(),
    stepCount: z.number().int(),
  }),
  event('step.entered', { ...stepRef, instruction: z.string(), targets: z.array(z.string()) }),
  event('step.completed', {
    ...stepRef,
    by: z.enum(['check', 'coach', 'user', 'skip']),
    forced: z.boolean().describe('Advanced before its success check passed'),
    durationMs: z.number().nonnegative(),
  }),
  event('procedure.completed', { durationMs: z.number().nonnegative() }),
  event('procedure.aborted', { reason: z.string() }),
  event('mistake.detected', {
    stepId: z.string(),
    kind: z.string(),
    message: z.string(),
    source: z.enum(['rule', 'coach']),
  }),
  event('hand.pinch', {
    hand: HandednessSchema,
    phase: z.enum(['start', 'end']),
    point: Vec3Schema,
    nearest: z.object({ objectId: z.string(), distance: z.number() }).nullable(),
  }),
  event('object.registered', {
    objectId: z.string(),
    position: Vec3Schema,
    method: PlacementMethodSchema,
  }),
  event('coach.status', {
    state: z.enum(['connecting', 'ready', 'reconnecting', 'closed', 'error']),
    detail: z.string().optional(),
  }),
  event('coach.narration', { kind: z.string(), text: z.string() }),
  event('coach.tool_call', {
    callId: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  event('coach.tool_result', {
    callId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    result: z.unknown(),
  }),
  event('transcript', {
    role: z.enum(['user', 'coach']),
    text: z.string(),
    final: z.boolean(),
  }),
  event('demo.playback', {
    stepId: z.string(),
    clipId: z.string(),
    phase: z.enum(['start', 'end']),
  }),
  event('media.started', { name: z.string(), mimeType: z.string() }),
  event('annotation', { label: z.string(), data: z.unknown().optional() }),
]);

export const EpisodeBatchSchema = z.object({
  seq: z.number().int().nonnegative().describe('Monotonic per episode; duplicates are ignored'),
  frames: z.array(FrameRecordSchema),
  events: z.array(EpisodeEventSchema),
});

export const EpisodeOutcomeSchema = z.enum(['completed', 'aborted', 'interrupted']);

export const EpisodeFinishSchema = z.object({
  durationMs: z.number().nonnegative(),
  outcome: EpisodeOutcomeSchema,
  stepsCompleted: z.number().int().nonnegative(),
  stepsTotal: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative().describe('Batches the client sent, for integrity checks'),
});

export type EpisodeMode = z.infer<typeof EpisodeModeSchema>;
export type CalibrationMethod = z.infer<typeof CalibrationMethodSchema>;
export type PlacementMethod = z.infer<typeof PlacementMethodSchema>;
export type CoachKind = z.infer<typeof CoachKindSchema>;
export type PlacedObject = z.infer<typeof PlacedObjectSchema>;
export type EpisodeMeta = z.infer<typeof EpisodeMetaSchema>;
export type EpisodeCreate = z.infer<typeof EpisodeCreateSchema>;
export type FrameRecord = z.infer<typeof FrameRecordSchema>;
export type EpisodeEvent = z.infer<typeof EpisodeEventSchema>;
export type EpisodeEventType = EpisodeEvent['type'];
export type EpisodeEventOf<T extends EpisodeEventType> = Extract<EpisodeEvent, { type: T }>;
/** An event payload as emitted on the headset bus: the recorder adds `t` relative to the episode. */
export type EpisodeEventPayload<T extends EpisodeEventType> = Omit<EpisodeEventOf<T>, 't' | 'type'>;
export type EpisodeBatch = z.infer<typeof EpisodeBatchSchema>;
export type EpisodeOutcome = z.infer<typeof EpisodeOutcomeSchema>;
export type EpisodeFinish = z.infer<typeof EpisodeFinishSchema>;

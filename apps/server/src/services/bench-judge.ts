import type { BenchJudgement, BenchScenario, ImagePayload, Procedure } from '@clio/protocol';
import type { Content, Part } from '@google/genai';
import { isRecord, parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';

// Pure: the planner bench's judge. A tester sets up a real scene, gives the planner a goal, and
// writes what a correct plan must (or must not) do there. The judge model sees the same views
// and grades the plan against each expectation. It is a second opinion next to the tester's own
// grade, so the bench can replay many scenarios unattended.

export type JudgeScenario = Pick<BenchScenario, 'goal' | 'context' | 'expect' | 'revise'>;

export interface JudgeRequest {
  scenario: JudgeScenario;
  procedure: Procedure;
  warnings: readonly string[];
  images: readonly ImagePayload[];
}

/** The judge port: one model call that returns raw JSON text. Tests use a scripted fake. */
export interface BenchJudge {
  readonly model: string;
  judge(request: JudgeRequest): Promise<string>;
}

export type JudgeAnswer = Pick<BenchJudgement, 'criteria' | 'issues' | 'passed'>;

const MAX_REASON_CHARS = 300;
const MAX_ISSUES = 5;

export const JUDGE_INSTRUCTION = [
  'You review lesson plans written by an AI planner for Clio, an AR coach that guides people ' +
    'through hands-on tasks step by step. A tester set up a real scene in front of a camera, ' +
    'gave the planner a goal, and wrote expectations: what a correct plan must (or must not) do ' +
    'in this scene. You see the camera views the planner saw, the goal, the plan, and the ' +
    'expectations.',
  '',
  '- `criteria`: one answer per expectation, in order, with its number `n`:',
  '  - `reason`: one sentence on what the plan does about it, citing step ids.',
  '  - `met`: true only if the plan as written meets the expectation. Judge what the plan ' +
    'says, not what the planner probably meant. An expectation about the scene ("notices that ' +
    'the cup is already full") is met only if the steps or the warnings show it.',
  '- `issues`: at most 3 other serious problems a careful teacher would catch: a step that is ' +
    'unsafe, impossible in this scene, in the wrong order, or about something that is not ' +
    'there, or a done-when state a camera could not confirm. [] if there are none.',
  '',
  'Be strict and concrete. Use the views to check what is really in the scene.',
].join('\n');

/** The plan as the judge reads it: compact text with every field that decides correctness. */
export function describePlan(
  procedure: Procedure,
  warnings: readonly string[],
  revisedFrom?: number,
): string {
  const lines = [`Title: ${procedure.title}`, `Summary: ${procedure.summary}`];
  lines.push(`Warnings: ${warnings.length ? warnings.join(' | ') : '(none)'}`, 'Objects:');
  for (const o of procedure.objects) {
    const look = o.tracking?.query ?? o.description;
    lines.push(`- ${o.id} (${o.label}, ${o.kind})${look ? `: ${look}` : ''}`);
  }
  lines.push('Steps:');
  procedure.steps.forEach((s, i) => {
    const done = revisedFrom !== undefined && i < revisedFrom ? ' [already done]' : '';
    lines.push(`${i + 1}. ${s.id}${done}: ${s.instruction}`);
    if (s.doneWhen) lines.push(`   Done when: ${s.doneWhen}`);
    if (s.action) lines.push(`   Action: ${describeAction(s.action)}`);
    if (s.show.length) lines.push(`   Outlines: ${s.show.map((item) => item.phrase).join(', ')}`);
    if (s.mistakes.length) {
      lines.push(`   Mistakes: ${s.mistakes.map((m) => `${m.kind}: ${m.message}`).join(' | ')}`);
    }
    if (s.coachNotes) lines.push(`   Coach notes: ${s.coachNotes}`);
  });
  return lines.join('\n');
}

function describeAction(action: NonNullable<Procedure['steps'][number]['action']>): string {
  const args = [action.object, action.target].filter(Boolean).join(' → ');
  const how = [action.direction, action.amount].filter((v) => v !== undefined).join(' ');
  const hand = action.hand && action.hand !== 'either' ? `${action.hand} hand` : '';
  const extra = [how, hand, action.note ?? ''].filter((v) => v !== '').join(', ');
  return `${action.verb}(${args})${extra ? ` ${extra}` : ''}`;
}

function judgeText({ scenario, procedure, warnings, images }: JudgeRequest): string {
  const { goal, context, expect, revise } = scenario;
  const lines = [`Goal: ${goal}`];
  if (context) lines.push(`What the learner said about their setup: ${context}`);
  const count = images.length;
  lines.push(
    count
      ? `Attached: the ${count} camera view${count === 1 ? '' : 's'} the planner saw.`
      : 'No camera views: the planner assumed a typical home setup.',
  );
  if (revise) {
    lines.push(
      `This is a re-plan in the middle of the lesson. The first ${revise.fromStepIndex} ` +
        `step${revise.fromStepIndex === 1 ? ' was' : 's were'} already done; the planner rewrote ` +
        `the rest because: ${revise.reason}`,
    );
  }
  lines.push(
    '',
    'THE PLAN',
    describePlan(procedure, warnings, revise?.fromStepIndex),
    '',
    'EXPECTATIONS',
    ...expect.map((e, i) => `${i + 1}. ${e}`),
    '',
    'Grade the plan against each expectation.',
  );
  return lines.join('\n');
}

/** One user turn: the views first, then the goal, the plan and the expectations. */
export function judgeContents(request: JudgeRequest): Content[] {
  const parts: Part[] = request.images.map((image) => ({
    inlineData: { mimeType: image.mimeType, data: image.data },
  }));
  parts.push({ text: judgeText(request) });
  return [{ role: 'user', parts }];
}

/** Structured output. `reason` comes before `met`, so the model explains before it decides. */
export function judgeJsonSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      criteria: {
        type: 'array',
        description: 'One answer per expectation, in order',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: 'The expectation number' },
            reason: { type: 'string', description: 'One sentence, citing step ids' },
            met: { type: 'boolean' },
          },
          required: ['n', 'reason', 'met'],
        },
      },
      issues: {
        type: 'array',
        description: 'At most 3 other serious problems; [] if none',
        items: { type: 'string' },
      },
    },
    required: ['criteria', 'issues'],
  };
}

/**
 * Reads the judge's answer against the expectations it was given. An expectation it skipped
 * counts as not met. Throws a readable Error when the answer is not usable at all.
 */
export function parseJudgement(text: string, expect: readonly string[]): JudgeAnswer {
  const json = parseModelJson(text);
  if (!json.ok) throw new Error(json.error);
  const answer = json.value;
  if (!isRecord(answer) || !Array.isArray(answer.criteria)) {
    throw new Error('The judge answer has no criteria');
  }
  const given = answer.criteria.filter(isRecord);
  const criteria = expect.map((expectation, i) => {
    const match =
      given.find((c) => c.n === i + 1) ?? (given[i]?.n === undefined ? given[i] : undefined);
    if (!match || typeof match.met !== 'boolean') {
      return { expectation, met: false, reason: 'The judge gave no answer for this one.' };
    }
    const reason = typeof match.reason === 'string' ? match.reason.trim() : '';
    return { expectation, met: match.met, reason: reason.slice(0, MAX_REASON_CHARS) };
  });
  const issues = (Array.isArray(answer.issues) ? answer.issues : [])
    .filter((i): i is string => typeof i === 'string' && i.trim() !== '')
    .map((i) => i.trim().slice(0, MAX_REASON_CHARS))
    .slice(0, MAX_ISSUES);
  return { criteria, issues, passed: criteria.every((c) => c.met) };
}

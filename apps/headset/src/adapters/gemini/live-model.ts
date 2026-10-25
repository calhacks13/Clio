import { ThinkingLevel } from '@google/genai';

// What a Live model accepts, measured against the API in October 2026. Both 3.8 voices are the same
// 3.1 Flash Live build (models.get reports version 3.1-flash-live-03-2026):
//   gemini-3.8-live                     takes BLOCKING and NON_BLOCKING declarations and a
//                                       response's `scheduling`, and has no thinking setting. It
//                                       calls start_lesson about 0.6 s after the learner's turn.
//   gemini-3.8-live-extended-thinking   the same with thinking. It closes the session (1007) on a
//                                       BLOCKING declaration ("BLOCKING function calls are not
//                                       supported"), on a response's `scheduling`, and when no
//                                       thinking level is named; MINIMAL is refused. With
//                                       `behavior` left out it waits for each answer, like a
//                                       blocking call, and at LOW calls start_lesson 2 to 3 s after
//                                       the turn.

export interface LiveModelTraits {
  /** Declarations may say BLOCKING or NON_BLOCKING; without it, `behavior` is left out. */
  toolBehavior: boolean;
  /** A tool response may carry `scheduling` (look_closer's WHEN_IDLE). */
  responseScheduling: boolean;
  /** The thinking level the session must name; null when the model has no thinking setting. */
  thinkingLevel: ThinkingLevel | null;
}

const PLAIN: LiveModelTraits = {
  toolBehavior: true,
  responseScheduling: true,
  thinkingLevel: null,
};

/** The least thinking these models take: the voice still has to answer in a breath. */
const THINKING: LiveModelTraits = {
  toolBehavior: false,
  responseScheduling: false,
  thinkingLevel: ThinkingLevel.LOW,
};

export function liveModelTraits(model: string): LiveModelTraits {
  return /(^|[-/])extended-thinking($|-)/.test(model) ? THINKING : PLAIN;
}

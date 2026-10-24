import { Behavior } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { toGeminiTools } from '../../src/adapters/gemini/declarations';
import { interpretServerMessage, TranscriptAggregator } from '../../src/adapters/gemini/messages';

describe('Gemini tool declarations', () => {
  const [tools] = toGeminiTools(['start_lesson', 'highlight']);
  const decls = tools?.functionDeclarations ?? [];

  it('converts tool argument schemas to Gemini schema format', () => {
    const highlight = decls.find((d) => d.name === 'highlight');
    expect(highlight?.parameters).toMatchObject({
      type: 'OBJECT',
      required: ['object_id'],
      properties: {
        object_id: { type: 'STRING' },
        style: { type: 'STRING', enum: ['target', 'attention', 'warning'] },
      },
    });
  });

  it('lets long-running tools run without blocking the conversation', () => {
    expect(decls.find((d) => d.name === 'start_lesson')?.behavior).toBe(Behavior.NON_BLOCKING);
    expect(decls.find((d) => d.name === 'highlight')?.behavior).toBe(Behavior.BLOCKING);
  });
});

describe('Gemini Live server messages', () => {
  it('extracts audio, transcripts and turn signals from server content', () => {
    const events = interpretServerMessage({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQA=' } }] },
        inputTranscription: { text: 'how do I' },
        outputTranscription: { text: 'First,' },
        interrupted: true,
        turnComplete: true,
      },
    });
    expect(events).toEqual([
      { kind: 'audio', data: 'AQA=', sampleRate: 24000 },
      { kind: 'transcript', role: 'user', text: 'how do I' },
      { kind: 'transcript', role: 'coach', text: 'First,' },
      { kind: 'interrupted' },
      { kind: 'turnComplete' },
    ]);
  });

  it('extracts tool calls, cancellations, go-away notices and resumption handles', () => {
    expect(
      interpretServerMessage({
        toolCall: { functionCalls: [{ id: 'f1', name: 'highlight', args: { object_id: 'cap' } }] },
        toolCallCancellation: { ids: ['f0'] },
        goAway: { timeLeft: '10s' },
        sessionResumptionUpdate: { newHandle: 'h2', resumable: true },
      }),
    ).toEqual([
      { kind: 'toolCalls', calls: [{ id: 'f1', name: 'highlight', args: { object_id: 'cap' } }] },
      { kind: 'toolCancel', ids: ['f0'] },
      { kind: 'goAway', timeLeft: '10s' },
      { kind: 'resumption', handle: 'h2' },
    ]);
  });

  it('ignores a resumption update that is not resumable', () => {
    expect(
      interpretServerMessage({ sessionResumptionUpdate: { newHandle: 'h3', resumable: false } }),
    ).toEqual([]);
  });
});

describe('TranscriptAggregator', () => {
  it('builds partial transcripts per role and finalizes them at the end of a turn', () => {
    const agg = new TranscriptAggregator();
    expect(agg.add('coach', 'Add ')).toEqual({ role: 'coach', text: 'Add ', final: false });
    expect(agg.add('coach', 'vinegar.')).toEqual({
      role: 'coach',
      text: 'Add vinegar.',
      final: false,
    });
    agg.add('user', 'ok');
    expect(agg.complete()).toEqual([
      { role: 'user', text: 'ok', final: true },
      { role: 'coach', text: 'Add vinegar.', final: true },
    ]);
    expect(agg.complete()).toEqual([]);
  });
});

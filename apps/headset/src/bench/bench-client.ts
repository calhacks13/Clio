import {
  type BenchCheckRequest,
  type BenchGrade,
  type BenchModelsResponse,
  BenchModelsResponseSchema,
  BenchPaths,
  type BenchPlanRequest,
  type BenchRun,
  BenchRunSchema,
  type BenchScenario,
  type BenchScenarioCreate,
  type BenchScenarioDetail,
  BenchScenarioDetailSchema,
  type BenchScenarioListResponse,
  BenchScenarioListResponseSchema,
  BenchScenarioSchema,
  type BenchScenarioUpdate,
  type StepCheckResponse,
  StepCheckResponseSchema,
} from '@clio/protocol';
import { z } from 'zod';
import { ApiClient } from '../adapters/net/api-client';

// The planner bench's routes on the laptop server, validated like every other response.

const OkSchema = z.object({ ok: z.literal(true) });

export class BenchClient extends ApiClient {
  models(): Promise<BenchModelsResponse> {
    return this.request('GET', BenchPaths.models, undefined, BenchModelsResponseSchema);
  }

  benchPlan(request: BenchPlanRequest): Promise<BenchRun> {
    return this.request('POST', BenchPaths.plan, request, BenchRunSchema);
  }

  benchCheck(request: BenchCheckRequest): Promise<StepCheckResponse> {
    return this.request('POST', BenchPaths.check, request, StepCheckResponseSchema);
  }

  scenarios(): Promise<BenchScenarioListResponse> {
    return this.request('GET', BenchPaths.scenarios, undefined, BenchScenarioListResponseSchema);
  }

  scenario(id: string): Promise<BenchScenarioDetail> {
    return this.request('GET', BenchPaths.scenario(id), undefined, BenchScenarioDetailSchema);
  }

  createScenario(body: BenchScenarioCreate): Promise<BenchScenarioDetail> {
    return this.request('POST', BenchPaths.scenarios, body, BenchScenarioDetailSchema);
  }

  updateScenario(id: string, patch: BenchScenarioUpdate): Promise<BenchScenario> {
    return this.request('PATCH', BenchPaths.scenario(id), patch, BenchScenarioSchema);
  }

  async deleteScenario(id: string): Promise<void> {
    await this.request('DELETE', BenchPaths.scenario(id), undefined, OkSchema);
  }

  runScenario(id: string, model: string, budgetMs?: number): Promise<BenchRun> {
    const body = budgetMs === undefined ? { model } : { model, budgetMs };
    return this.request('POST', BenchPaths.scenarioRuns(id), body, BenchRunSchema);
  }

  gradeRun(
    id: string,
    runId: string,
    verdict: { grade: BenchGrade; notes?: string } | null,
  ): Promise<BenchRun> {
    return this.request('PATCH', BenchPaths.scenarioRun(id, runId), { verdict }, BenchRunSchema);
  }

  judgeRun(id: string, runId: string, model: string): Promise<BenchRun> {
    return this.request('POST', BenchPaths.scenarioRunJudge(id, runId), { model }, BenchRunSchema);
  }

  viewUrl(id: string, n: number): string {
    return this.base + BenchPaths.scenarioView(id, n);
  }
}

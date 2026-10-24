import {
  type BenchCheckRequest,
  type BenchCheckRun,
  BenchCheckRunSchema,
  type BenchCheckTest,
  type BenchCheckTestCreate,
  type BenchCheckTestDetail,
  BenchCheckTestDetailSchema,
  type BenchCheckTestListResponse,
  BenchCheckTestListResponseSchema,
  BenchCheckTestSchema,
  type BenchCheckTestUpdate,
  type BenchGrade,
  type BenchModelsResponse,
  BenchModelsResponseSchema,
  BenchPaths,
  type BenchPlanRequest,
  type BenchRun,
  type BenchRunScenarioRequest,
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

  /** `staged` asks for one stage of a two-stage plan; "rest" needs the plan to refine. */
  runScenario(
    id: string,
    model: string,
    budgetMs?: number,
    staged?: Pick<BenchRunScenarioRequest, 'stage' | 'revise'>,
  ): Promise<BenchRun> {
    const body: BenchRunScenarioRequest = {
      model,
      ...(budgetMs === undefined ? {} : { budgetMs }),
      ...staged,
    };
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

  // Watcher tests

  checkTests(): Promise<BenchCheckTestListResponse> {
    return this.request('GET', BenchPaths.checkTests, undefined, BenchCheckTestListResponseSchema);
  }

  checkTest(id: string): Promise<BenchCheckTestDetail> {
    return this.request('GET', BenchPaths.checkTest(id), undefined, BenchCheckTestDetailSchema);
  }

  createCheckTest(body: BenchCheckTestCreate): Promise<BenchCheckTestDetail> {
    return this.request('POST', BenchPaths.checkTests, body, BenchCheckTestDetailSchema);
  }

  updateCheckTest(id: string, patch: BenchCheckTestUpdate): Promise<BenchCheckTest> {
    return this.request('PATCH', BenchPaths.checkTest(id), patch, BenchCheckTestSchema);
  }

  async deleteCheckTest(id: string): Promise<void> {
    await this.request('DELETE', BenchPaths.checkTest(id), undefined, OkSchema);
  }

  runCheckTest(id: string, model: string): Promise<BenchCheckRun> {
    return this.request('POST', BenchPaths.checkTestRuns(id), { model }, BenchCheckRunSchema);
  }

  checkFrameUrl(id: string, file: string): string {
    return this.base + BenchPaths.checkTestFrame(id, file);
  }
}

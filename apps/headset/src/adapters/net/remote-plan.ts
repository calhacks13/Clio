import type {
  Procedure,
  StepCheckRequest,
  StepCheckResponse,
  StepCriteriaRequest,
  StepCriteriaResponse,
} from '@clio/protocol';
import type { StepChecker } from '../../domain/session/step-watcher';
import type { TemplateSource, TemplateSummary } from '../../domain/session/templates';
import type { ApiClient } from './api-client';

// The coach's plan ports implemented by the laptop server: the step watcher's judge and the
// curated lessons a plan can start from.

export class RemoteStepChecker implements StepChecker {
  constructor(private readonly api: ApiClient) {}
  check(request: StepCheckRequest): Promise<StepCheckResponse> {
    return this.api.checkStep(request);
  }
  criteria(request: StepCriteriaRequest): Promise<StepCriteriaResponse> {
    return this.api.stepCriteria(request);
  }
}

export class RemoteTemplates implements TemplateSource {
  constructor(private readonly api: ApiClient) {}
  /** The curated lessons only (procedures/ in the repo), not plans the planner wrote. */
  async list(): Promise<TemplateSummary[]> {
    const { procedures } = await this.api.procedures();
    return procedures
      .filter((p) => p.source === 'curated')
      .map(({ id, title, summary }) => ({ id, title, summary }));
  }
  get(id: string): Promise<Procedure> {
    return this.api.procedure(id);
  }
}

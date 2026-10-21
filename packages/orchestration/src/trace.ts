export type TraceStage = 'request' | 'plan' | 'permission' | 'approval' | 'execute' | 'reply' | 'error';

export interface OrchestrationTrace {
  id: string;
  timestamp: string;
  requestId: string;
  planId?: string;
  stage: TraceStage;
  summary: string;
  data?: Record<string, unknown>;
}

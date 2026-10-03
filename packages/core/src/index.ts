export type Id = string;

export type JobStatus =
  | "CREATED"
  | "PREPARING"
  | "SUBMITTING"
  | "GENERATING"
  | "VERIFYING"
  | "DOWNLOADING"
  | "VALIDATING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface GenerationRequest {
  projectId: Id;
  sceneId: Id;
  prompt: string;
  references?: string[];
  provider: string;
  metadata?: Record<string, unknown>;
}

export interface GenerationResult {
  jobId: Id;
  provider: string;
  status: JobStatus;
  assets: string[];
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly id: string;
  connect(): Promise<void>;
  inspectState(): Promise<Record<string, unknown>>;
  submit(request: GenerationRequest): Promise<{ externalId?: string }>;
  waitForCompletion(externalId: string): Promise<GenerationResult>;
  download(result: GenerationResult): Promise<string[]>;
  disconnect(): Promise<void>;
}

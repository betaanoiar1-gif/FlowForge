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


export type JobEvent = {
  from: JobStatus;
  to: JobStatus;
  at: string;
  error?: string;
};

export interface GenerationJob {
  id: Id;
  request: GenerationRequest;
  status: JobStatus;
  externalId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  CREATED: ["PREPARING", "CANCELLED"],
  PREPARING: ["SUBMITTING", "FAILED", "CANCELLED"],
  SUBMITTING: ["GENERATING", "FAILED", "CANCELLED"],
  GENERATING: ["VERIFYING", "FAILED", "CANCELLED"],
  VERIFYING: ["DOWNLOADING", "FAILED", "CANCELLED"],
  DOWNLOADING: ["VALIDATING", "FAILED", "CANCELLED"],
  VALIDATING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["PREPARING", "CANCELLED"],
  CANCELLED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }
}

export function transitionJob(job: GenerationJob, to: JobStatus, error?: string): GenerationJob {
  assertTransition(job.status, to);
  const now = new Date().toISOString();
  return {
    ...job,
    status: to,
    error: to === "FAILED" ? error ?? job.error : undefined,
    updatedAt: now,
  };
}


export interface ProjectRecord {
  id: Id;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SceneRecord {
  id: Id;
  projectId: Id;
  name: string;
  sequence: number;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterRecord {
  id: Id;
  projectId: Id;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SceneCharacterRecord {
  sceneId: Id;
  characterId: Id;
  role?: string;
  createdAt: string;
}

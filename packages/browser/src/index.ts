export type BrowserState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "PAGE_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "READY"
  | "BUSY"
  | "ERROR";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

/** Provider-neutral projection of a single visible browser element. */
export interface SemanticElement {
  tagName: string;
  role: string | null;
  accessibleName: string;
  text: string;
  href: string | null;
  inputType: string | null;
  contenteditable: boolean;
  disabled: boolean;
  visible: boolean;
  selected: boolean | null;
}

export interface PageDiscovery {
  url: string;
  title: string;
  readyState: string;
  elements: SemanticElement[];
}

/** Visible page data only; callers must not persist or log arbitrary text. */
export interface PageObservation extends PageDiscovery {
  visibleText: string;
}

export interface SemanticQuery {
  role?: string;
  name?: string | RegExp;
  text?: string | RegExp;
  href?: string | RegExp;
  exact?: boolean;
  visible?: boolean;
  /** By default only enabled controls match; false selects disabled controls, true selects enabled ones. */
  enabled?: boolean;
  /** Includes both enabled and disabled controls, for state inspection only. */
  includeDisabled?: boolean;
  contenteditable?: boolean;
}

export interface DomDiagnosticElement {
  tagName: string;
  role: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  name: string | null;
  type: string | null;
  contenteditable: string | null;
  value: string | null;
  text: string;
  parentText: string;
  html: string;
}

export interface DomDiagnostics {
  inputs: DomDiagnosticElement[];
  buttons: DomDiagnosticElement[];
}

export interface SemanticMatch {
  matched: boolean;
  count: number;
  element: SemanticElement | null;
}

export interface SemanticActionResult {
  action: "click";
  query: SemanticQuery;
  matched: boolean;
  /** True once the unique target's click handler was actually dispatched. */
  dispatched: boolean;
  /** True only when a visible page-state change verified the action. */
  verified: boolean;
  /** True when the bounded action/verification deadline elapsed. */
  timedOut?: boolean;
  beforeUrl: string;
  afterUrl: string;
  beforeTitle: string;
  afterTitle: string;
  error?: string;
}

export interface SemanticInputResult {
  action: "fill";
  query: SemanticQuery;
  matched: boolean;
  verified: boolean;
  timedOut?: boolean;
  beforeLength: number;
  afterLength: number;
  error?: string;
}

export interface BrowserDownload {
  path: string;
  fileName: string;
}

export { BrowserGatewayError } from "./errors.js";

export interface BrowserUpload {
  fileNames: string[];
}

export interface BrowserGateway {
  /** Opaque, non-secret identifier for the attached browser endpoint/session. */
  readonly sessionId?: string;
  /** Attach to a browser the user launched and authenticated manually. */
  connect(): Promise<void>;
  /** Detach without reading or persisting authentication material. */
  disconnect(): Promise<void>;
  state(): Promise<BrowserState>;
  tabs(): Promise<BrowserTab[]>;
  selectTab(tabId: string): Promise<void>;
  open(url: string, options?: { newTab?: boolean }): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  discoverPage(): Promise<PageDiscovery>;
  observe(): Promise<PageObservation>;
  domDiagnostics(): Promise<DomDiagnostics>;
  resolve(query: SemanticQuery): Promise<SemanticMatch>;
  waitFor(query: SemanticQuery, timeoutMs?: number): Promise<SemanticMatch>;
  click(query: SemanticQuery, timeoutMs?: number): Promise<SemanticActionResult>;
  hover(query: SemanticQuery, timeoutMs?: number): Promise<boolean>;
  fill(
    query: SemanticQuery,
    value: string,
    timeoutMs?: number,
    options?: { expectedBeforeValue?: string },
  ): Promise<SemanticInputResult>;
  upload(trigger: SemanticQuery, filePaths: string[], timeoutMs?: number): Promise<BrowserUpload>;
  download(query: SemanticQuery, destinationDirectory: string, timeoutMs?: number): Promise<BrowserDownload>;
}

export { CdpBrowserGateway } from "./cdp.js";

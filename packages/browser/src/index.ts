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
}

export interface PageDiscovery {
  url: string;
  title: string;
  readyState: string;
  elements: SemanticElement[];
}

export interface SemanticQuery {
  role?: string;
  name?: string | RegExp;
  text?: string | RegExp;
  href?: string | RegExp;
  exact?: boolean;
  visible?: boolean;
  enabled?: boolean;
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
  verified: boolean;
  beforeUrl: string;
  afterUrl: string;
  beforeTitle: string;
  afterTitle: string;
  error?: string;
}

export interface BrowserGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  state(): Promise<BrowserState>;
  tabs(): Promise<BrowserTab[]>;
  open(url: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  discoverPage(): Promise<PageDiscovery>;
  domDiagnostics(): Promise<DomDiagnostics>;
  resolve(query: SemanticQuery): Promise<SemanticMatch>;
  click(query: SemanticQuery, timeoutMs?: number): Promise<SemanticActionResult>;
}

export { CdpBrowserGateway } from "./cdp.js";

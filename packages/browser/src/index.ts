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
  disabled: boolean;
  visible: boolean;
}

export interface PageDiscovery {
  url: string;
  title: string;
  readyState: string;
  elements: SemanticElement[];
}

export interface BrowserGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  state(): Promise<BrowserState>;
  tabs(): Promise<BrowserTab[]>;
  open(url: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  discoverPage(): Promise<PageDiscovery>;
}

export { CdpBrowserGateway } from "./cdp.js";

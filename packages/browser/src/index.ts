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

export interface BrowserGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  state(): Promise<BrowserState>;
  tabs(): Promise<BrowserTab[]>;
  open(url: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
}

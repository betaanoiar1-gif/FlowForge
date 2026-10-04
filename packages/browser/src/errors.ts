export class BrowserGatewayError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, options: { timedOut?: boolean } = {}) {
    super(message);
    this.name = "BrowserGatewayError";
    this.timedOut = options.timedOut ?? false;
  }
}

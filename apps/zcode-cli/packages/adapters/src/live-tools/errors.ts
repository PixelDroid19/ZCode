import type { LiveToolConfigurationErrorCode } from "./types.js";

export class LiveToolConfigurationError extends Error {
  readonly code: LiveToolConfigurationErrorCode;
  readonly path?: string;

  constructor(
    code: LiveToolConfigurationErrorCode,
    message: string,
    options: { cause?: unknown; path?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LiveToolConfigurationError";
    this.code = code;
    this.path = options.path;
  }
}

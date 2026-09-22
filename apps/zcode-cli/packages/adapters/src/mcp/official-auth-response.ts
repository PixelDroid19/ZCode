const REQUEST_ID_HEADER = "x-request-id";

export function isOfficialMcpRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export function readOfficialMcpServerRequestId(response: Response): string | undefined {
  const value = response.headers.get(REQUEST_ID_HEADER)?.trim();
  return value ? value : undefined;
}

export function withOfficialMcpServerRequestId(message: string, response: Response): string {
  const requestId = readOfficialMcpServerRequestId(response);
  return requestId ? `${message} - ${requestId}` : message;
}

export function safeOfficialMcpPath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "(unparsable)";
  }
}

export function officialMcpBodyByteLength(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

export function numericHttpHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

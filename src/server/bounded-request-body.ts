export class BoundedRequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedRequestBodyError";
  }
}

/** Reads a request body without ever retaining more than the declared byte bound. */
export async function readBoundedUtf8Body(request: Request, maximumBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new Error("invalid request body byte bound");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes))
    throw new BoundedRequestBodyError("request body exceeds byte limit");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new BoundedRequestBodyError("request body exceeds byte limit");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) throw error;
    throw new BoundedRequestBodyError("request body could not be read");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundedRequestBodyError("request body is not UTF-8");
  }
}

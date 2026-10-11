// The one shared, pure step this service's scripts/*.mjs CLI entries reuse: concatenating an
// async-iterable byte/text stream into one string. It takes the stream as a value the caller
// passes (this service's four scripts/ entries each pass their own process.stdin) rather than
// reading process.stdin itself, so it stays hull -- no relative import of a kernel module
// depends on it, and it never becomes one either (data/records/house-architecture-norms.json,
// "hull-never-imports-kernel").
export async function collectStreamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

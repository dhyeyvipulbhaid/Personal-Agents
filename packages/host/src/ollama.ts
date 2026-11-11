/** Client probe. This process does not listen. */
export async function probeOllama(
  port = 11434,
  timeoutMs = 300,
): Promise<"running" | "stopped"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? "running" : "stopped";
  } catch {
    return "stopped";
  }
}

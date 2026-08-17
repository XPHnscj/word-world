const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizeClientProviderUrl(
  value: unknown,
  allowLocalHttp = process.env.NODE_ENV !== "production",
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const isLocal = LOCAL_HOSTS.has(hostname);
    if (url.username || url.password) return null;
    if (url.protocol === "http:" && allowLocalHttp && isLocal)
      return url.toString().replace(/\/$/, "");
    if (url.protocol !== "https:" || isPrivateHost(hostname)) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function trustedServerProviderUrl(value: string | undefined) {
  return (value?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
}

function isPrivateHost(hostname: string) {
  if (
    LOCAL_HOSTS.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.startsWith("[")
  )
    return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

import * as SecureStore from "expo-secure-store";

export type OpenAiApiStatusKind =
  | "unknown"
  | "key_valid"
  | "working"
  | "no_credits"
  | "invalid_key"
  | "network_error"
  | "service_error";

export type OpenAiApiStatus = {
  kind: OpenAiApiStatusKind;
  checkedAt: string | null;
  detail?: string | null;
};

const STORAGE_KEY = "looi.openai-api-status.v1";
let cachedStatus: OpenAiApiStatus | undefined;

const UNKNOWN_STATUS: OpenAiApiStatus = { kind: "unknown", checkedAt: null };

export async function getOpenAiApiStatus(): Promise<OpenAiApiStatus> {
  if (cachedStatus) return cachedStatus;
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return UNKNOWN_STATUS;
    const parsed = JSON.parse(raw) as Partial<OpenAiApiStatus>;
    if (!isKind(parsed.kind)) return UNKNOWN_STATUS;
    cachedStatus = {
      kind: parsed.kind,
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : null,
      detail: typeof parsed.detail === "string" ? parsed.detail : null,
    };
    return cachedStatus;
  } catch {
    return UNKNOWN_STATUS;
  }
}

export async function setOpenAiApiStatus(kind: OpenAiApiStatusKind, detail?: string | null): Promise<void> {
  const status: OpenAiApiStatus = {
    kind,
    checkedAt: new Date().toISOString(),
    detail: detail ? detail.slice(0, 180) : null,
  };
  cachedStatus = status;
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(status));
  } catch {
    // Status is diagnostic UX only. Never fail the conversation because this
    // non-secret convenience state could not be persisted.
  }
}

export async function clearOpenAiApiStatus(): Promise<void> {
  cachedStatus = UNKNOWN_STATUS;
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {
    // Best effort only.
  }
}

export function classifyOpenAiError(code: unknown, message: unknown): OpenAiApiStatusKind | null {
  const normalizedCode = String(code ?? "").toLowerCase();
  const normalizedMessage = String(message ?? "").toLowerCase();
  const combined = `${normalizedCode} ${normalizedMessage}`;
  if (combined.includes("credit_balance_exhausted") || combined.includes("insufficient_quota") || combined.includes("no credits")) {
    return "no_credits";
  }
  if (combined.includes("invalid_api_key") || combined.includes("incorrect api key") || combined.includes("authentication") || combined.includes("http 401")) {
    return "invalid_key";
  }
  return null;
}

function isKind(value: unknown): value is OpenAiApiStatusKind {
  return value === "unknown" || value === "key_valid" || value === "working" || value === "no_credits" || value === "invalid_key" || value === "network_error" || value === "service_error";
}

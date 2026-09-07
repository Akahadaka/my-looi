import { AppState, Platform } from "react-native";

import { getPhotoPickerAccessModule, type RealtimePhotoPayload } from "../../modules/photo-picker-access";
import { resumeAppRuntime } from "../core/app-bootstrap";
import { withExternalActivityLease } from "../core/background-process-exit";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { voiceRuntime } from "../perceivers/voice-runtime";
import { useConversationStore } from "../store/conversation";
import { realtimeConversationService } from "../voice/realtime-conversation";

const PHOTO_PICKER_MAX_ITEMS = 4;
const REALTIME_READY_TIMEOUT_MS = 18_000;
const CONTINUATION_MAX_CHARS = 5_500;
const CONTINUATION_MAX_MESSAGES = 14;

function buildRecentConversationContinuation(): string {
  const messages = useConversationStore.getState().messages.slice(-CONTINUATION_MAX_MESSAGES);
  const lines: string[] = [];
  let chars = 0;
  for (const message of messages) {
    const content = message.content.replace(/\s+/g, " ").trim();
    if (!content) continue;
    const bounded = content.slice(0, 900);
    const line = `${message.role === "assistant" ? "LOOI" : "User"}: ${bounded}`;
    if (chars + line.length > CONTINUATION_MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
}

async function waitForAppActive(timeoutMs = 8_000): Promise<void> {
  if (AppState.currentState === "active") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.remove();
      reject(new Error("My LOOI did not return to the foreground after Photo Picker"));
    }, timeoutMs);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      clearTimeout(timeout);
      subscription.remove();
      resolve();
    });
  });
}

async function waitForRealtimeReady(timeoutMs = REALTIME_READY_TIMEOUT_MS): Promise<void> {
  if (realtimeConversationService.isReadyForVisualContext) return;
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const conversation = useConversationStore.getState();
      if (realtimeConversationService.isReadyForVisualContext && conversation.realtimeReadiness === "ready") {
        finish();
        return;
      }
      if (conversation.realtimeReadiness === "error" || conversation.realtimeReadiness === "microphone-error") {
        finish(new Error("Realtime could not resume after Photo Picker"));
      }
    };
    const unsubscribe = useConversationStore.subscribe(check);
    timeout = setTimeout(() => {
      finish(new Error(`Realtime did not become ready within ${Date.now() - startedAt} ms after Photo Picker`));
    }, timeoutMs);
    check();
  });
}

export type SelectedPhotoContextResult = {
  selected: number;
  cancelled: boolean;
};

/**
 * Let Android grant scoped access only to photos explicitly selected by the
 * user, then add those images to the current Realtime discussion. The picker
 * runs under an external-activity lease: microphone/BLE/Realtime still hard
 * suspend in background, but the native five-second process kill is skipped so
 * the recent text conversation can be reseeded after returning.
 */
export async function selectPhotosIntoCurrentDiscussion(): Promise<SelectedPhotoContextResult> {
  if (Platform.OS !== "android") throw new Error("Android Photo Picker is available only on Android");
  const module = getPhotoPickerAccessModule();
  if (!module) throw new Error("Android Photo Picker module is unavailable");

  const continuationContext = buildRecentConversationContinuation();
  recordDiagnosticEvent("vision", "photo-picker-opened", {
    maxItems: PHOTO_PICKER_MAX_ITEMS,
    continuationMessages: continuationContext ? continuationContext.split("\n").length : 0,
    continuationChars: continuationContext.length,
  });

  const selected = await withExternalActivityLease("visual-photo-picker", () =>
    module.selectPhotos(PHOTO_PICKER_MAX_ITEMS)
  );
  if (selected.length === 0) {
    recordDiagnosticEvent("vision", "photo-picker-cancelled");
    await module.clearSelection().catch(() => undefined);
    return { selected: 0, cancelled: true };
  }

  const persistedGrantCount = selected.filter((photo) => photo.persistedGrant === true).length;
  recordDiagnosticEvent("vision", "photo-picker-selected", {
    count: selected.length,
    totalReportedBytes: selected.reduce((sum, photo) => sum + Math.max(0, Number(photo.sizeBytes) || 0), 0),
    scopedUriAccess: true,
    persistedGrantCount,
    temporaryGrantCount: selected.length - persistedGrantCount,
  });

  const payloads: RealtimePhotoPayload[] = [];
  try {
    await waitForAppActive();

    // Read/normalize the selected photos immediately after Photo Picker
    // returns, while Android's scoped URI grant is unquestionably fresh. On
    // providers that support persistable grants, the native module also keeps
    // those grants until clearSelection() below. This avoids delaying URI I/O
    // behind Realtime/BLE/microphone restoration.
    for (const photo of selected) {
      const payload = await module.readSelectedPhotoForRealtime(photo.uri);
      payloads.push(payload);
      recordDiagnosticEvent("vision", "photo-picker-image-prepared", {
        index: payloads.length,
        totalPhotos: selected.length,
        width: payload.width,
        height: payload.height,
        encodedBytes: payload.encodedBytes,
        originalMimeType: payload.originalMimeType,
        outputMimeType: payload.mimeType,
        persistedGrant: photo.persistedGrant === true,
        uriLogged: false,
      });
    }

    // AppState background handling intentionally stopped mic/BLE/Realtime.
    // Restore that protected runtime only after the selected images are safely
    // prepared in memory, then reopen the face conversation and inject them.
    await resumeAppRuntime();
    await voiceRuntime.resumeMainScreenConversation("foreground-resume");
    await waitForRealtimeReady();

    realtimeConversationService.beginSelectedPhotoContext(continuationContext, payloads.length);
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index];
      realtimeConversationService.addSelectedPhotoToContext(payload, index + 1, payloads.length);
      // Drop the large JS string as soon as its WebSocket/DataChannel event has
      // been serialized. The native picker URI remains temporary and is cleared
      // below; no app-owned photo file is created.
      payload.base64 = "";
    }
    realtimeConversationService.finishSelectedPhotoContext(payloads.length);
    recordDiagnosticEvent("vision", "photo-picker-discussion-ready", {
      count: payloads.length,
      conversationRestored: true,
      retainedByApp: false,
    });
    return { selected: payloads.length, cancelled: false };
  } finally {
    payloads.forEach((payload) => { payload.base64 = ""; });
    await module.clearSelection().catch(() => undefined);
  }
}

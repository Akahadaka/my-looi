import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type PickedPhoto = {
  uri: string;
  mimeType: string;
  sizeBytes?: number | null;
  persistedGrant?: boolean;
};

export type RealtimePhotoPayload = {
  uri: string;
  mimeType: "image/jpeg";
  base64: string;
  width: number;
  height: number;
  encodedBytes: number;
  originalMimeType: string;
};

declare class PhotoPickerAccessNativeModule extends NativeModule {
  selectPhotos(maxItems: number): Promise<PickedPhoto[]>;
  readSelectedPhotoForRealtime(uri: string): Promise<RealtimePhotoPayload>;
  clearSelection(): Promise<void>;
}

let cached: PhotoPickerAccessNativeModule | null | undefined;

function getModule(): PhotoPickerAccessNativeModule | null {
  if (Platform.OS !== "android") return null;
  if (cached !== undefined) return cached;
  try {
    cached = requireNativeModule<PhotoPickerAccessNativeModule>("PhotoPickerAccess");
  } catch {
    cached = null;
  }
  return cached;
}

export function getPhotoPickerAccessModule(): PhotoPickerAccessNativeModule | null {
  return getModule();
}

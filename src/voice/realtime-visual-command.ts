import type { CustomVoiceCommandPhrase, UserPreferences } from "../store/user";
import { getExplicitRobotAddressedCommand } from "./explicit-robot-command";

export type VisualCameraFacing = "front" | "back";
export type RealtimeVisualCommand = { kind: "look-here"; cameraFacing: VisualCameraFacing };

type VisualCommandPreferences = Pick<UserPreferences,
  "robotName" | "robotAddressAliases" | "robotAddressRecognitionAliases" | "listeningLanguage" | "customVoiceCommands"
>;

function normalize(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/ё/g, "е")
    .replace(/[’'`]/g, "")
    .replace(/[^a-zа-яіїєґ0-9\s]/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function customLookPhraseMatches(command: string, preferences: VisualCommandPreferences): boolean {
  const phrases = preferences.customVoiceCommands.look_here ?? [];
  const activeLanguage = preferences.listeningLanguage;
  const active = phrases.some((phrase: CustomVoiceCommandPhrase) =>
    phrase.language === activeLanguage && normalize(phrase.text) === command
  );
  if (active) return true;
  return phrases.some((phrase) => normalize(phrase.text) === command);
}

function stripLeadIns(command: string): string {
  let value = command;
  const leadIn = /^(?:(?:ну\s+)?давай(?:-ка)?|ну-ка|теперь|а\s+теперь|ладно|хорошо|окей|пожалуйста|будь\s+добр(?:а|ы)?|будь\s+ласка|please)\s+/iu;
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(leadIn, "").trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

const BACK_CAMERA_RE = /(?:задн(?:ей|юю|ю|яя|я|ьою)\s+камер(?:ой|ою|у|а)|через\s+задн(?:юю|ю)\s+камеру|на\s+задн(?:юю|ю)\s+камеру|тильн(?:ою|у|а)\s+камер(?:ою|ой|у|а)|rear\s+camera|back\s+camera)/iu;
const FRONT_CAMERA_RE = /(?:фронтал(?:ьной|ьную|ка)|передн(?:ей|юю|яя)\s+камер(?:ой|у|а)|фронтальн(?:ою|у|а)\s+камер(?:ою|у|а)|front\s+camera|selfie\s+camera)/iu;

function requestedCameraFacing(command: string): VisualCameraFacing {
  if (BACK_CAMERA_RE.test(command)) return "back";
  if (FRONT_CAMERA_RE.test(command)) return "front";
  return "front";
}

function stripCameraQualifier(command: string): string {
  return command.replace(BACK_CAMERA_RE, " ").replace(FRONT_CAMERA_RE, " ").replace(/\s+/g, " ").trim();
}

function looksLikeVisualIntent(command: string): boolean {
  if (!command) return false;
  // Addressing is already enforced before this matcher. For a non-physical
  // camera action we intentionally accept natural tails after the visual verb:
  // “смотри, что я показываю”, “посмотри на эту упаковку”, etc.
  if (/^(?:посмотри|смотри|глянь|взгляни|рассмотри|прочитай|прочти|сфотографируй|сними)(?:\s|$)/iu.test(command)) return true;
  if (/^(?:подивись|дивись|глянь|поглянь|прочитай|сфотографуй|зніми)(?:\s|$)/iu.test(command)) return true;
  if (/^(?:look|see|read|photograph|take\s+(?:a\s+)?(?:look|photo|picture)|show\s+me)(?:\s|$)/iu.test(command)) return true;
  if (/^(?:что|чего)\s+(?:ты\s+)?(?:видишь|видно|здесь|тут)|^что\s+(?:здесь|тут)\s+(?:написано|изображено|нарисовано)/iu.test(command)) return true;
  if (/^що\s+(?:ти\s+)?(?:бачиш|видно|тут|тут\s+написано|це)/iu.test(command)) return true;
  if (/^what(?:\s+do\s+you\s+see|\s+is|'s)\s+(?:this|here)/iu.test(command)) return true;
  return false;
}

/**
 * Parse only an explicitly addressed visual request. Unlike emergency STOP,
 * look-here is never global: the robot name/address must begin the utterance.
 * Camera choice is explicit only when the user says front/back; otherwise the
 * existing front-camera behavior remains the default.
 */
export function parseRealtimeVisualCommand(
  transcript: string,
  preferenceSnapshot: VisualCommandPreferences,
): RealtimeVisualCommand | null {
  const addressed = getExplicitRobotAddressedCommand(transcript, {
    robotName: preferenceSnapshot.robotName,
    robotAddressAliases: preferenceSnapshot.robotAddressAliases,
    robotAddressRecognitionAliases: preferenceSnapshot.robotAddressRecognitionAliases,
    listeningLanguage: preferenceSnapshot.listeningLanguage,
    customVoiceCommands: preferenceSnapshot.customVoiceCommands,
  });
  if (!addressed) return null;
  const command = stripLeadIns(normalize(addressed));
  const cameraFacing = requestedCameraFacing(command);
  const withoutCamera = stripCameraQualifier(command);
  if (customLookPhraseMatches(command, preferenceSnapshot) || customLookPhraseMatches(withoutCamera, preferenceSnapshot)) {
    return { kind: "look-here", cameraFacing };
  }
  return looksLikeVisualIntent(withoutCamera) ? { kind: "look-here", cameraFacing } : null;
}

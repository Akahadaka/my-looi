/**
 * Where LOOI is and what it may do. This is runtime state the user can change
 * by voice ("you're on the floor, feel free to explore") or in Settings, not a
 * belief baked into the persona. Everything that moves the robot reads it via
 * the motion policy. Pure TypeScript: no React Native imports.
 */

export type RobotSurface = "desk" | "floor" | "unknown";
export type RobotFreedom = "stay" | "explore";

export type RobotSituation = {
  surface: RobotSurface;
  freedom: RobotFreedom;
};

export const DEFAULT_ROBOT_SITUATION: RobotSituation = { surface: "desk", freedom: "stay" };

export function normalizeRobotSurface(value: unknown): RobotSurface {
  return value === "desk" || value === "floor" || value === "unknown" ? value : DEFAULT_ROBOT_SITUATION.surface;
}

export function normalizeRobotFreedom(value: unknown): RobotFreedom {
  return value === "stay" || value === "explore" ? value : DEFAULT_ROBOT_SITUATION.freedom;
}

export function normalizeRobotSituation(value: unknown): RobotSituation {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { surface: normalizeRobotSurface(record.surface), freedom: normalizeRobotFreedom(record.freedom) };
}

/** One or two sentences for the Realtime persona. Kept short: the model repeats what it is told. */
export function describeRobotSituationForPersona(situation: RobotSituation): string {
  const where = situation.surface === "floor"
    ? "Right now you are on the floor."
    : situation.surface === "desk"
      ? "Right now you are on a desk."
      : "You do not know what surface you are on right now.";
  const may = situation.freedom === "explore"
    ? "You are allowed to move around and explore a little; the app drives safely on your behalf, so do not refuse and do not narrate driving."
    : "You stay where you are unless the app moves you.";
  return `${where} ${may} The user can see your surroundings and you cannot: if they tell you where you are or what you may do, accept it, call set_situation, and never argue about it.`;
}

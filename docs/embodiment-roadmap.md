# Embodiment roadmap: from desk toy to a robot that can follow a toddler

Context (Andrew, 2026-09-13): LOOI should take instructions in plain language without the
"LOOI, do X" override, know when it is on the floor with freedom to explore, and
eventually follow (or run away from, using the back camera) a one-year-old. None of that is
built. This page records the layering so that what ships now leaves the right seams.

## Layers

```
 user speech ─► Realtime model ─► intents (tools)      ─┐
 Settings     ─► robot situation (surface, freedom)     ─┼─► motion policy ─► behaviours ─► safety controller ─► BLE
 back camera  ─► target observations (person, distance) ─┘        ▲                 ▲
 choreography plans ────────────────────────────────────────────────┘                 │
 addressed commands / STOP (deterministic, always win) ───────────────────────────────┘
```

1. **Robot situation** (`src/robot/robot-situation.ts`, shipped): where LOOI stands and
   whether it may move around. Persisted preference, changed by the `set_situation`
   Realtime tool or Settings, injected into the persona each session so the model never
   argues about its surroundings.
2. **Motion policy** (`src/robot/motion-policy.ts`, shipped as a seam): turns situation
   plus user level into an envelope (pivot ceiling, spin allowed, translation allowed,
   behaviours allowed). Only choreography reads it today. Future: ambient motion and
   camera attention read it too, so the floor gets a wider envelope than the desk.
3. **Behaviours** (future): long-running controllers with a priority below choreography
   and above ambient motion, each owning its own stop conditions.
   - *Explore*: short bounded legs with turns, cliff and TOF gated, time-boxed, returns to
     idle. Needs the situation to be floor + explore.
   - *Follow*: keep a person in the back camera at a target distance (TOF plus bounding-box
     height), tiny corrections, never closer than a safety margin.
   - *Flee*: the same tracker with the sign flipped, plus an escape budget so it does not
     drive under furniture.
4. **Intents via tools** (future): the model gets intent tools (`explore`, `follow_person`,
   `stop_behaviour`) rather than raw driving. Each intent is checked against the policy and
   executed by a behaviour. The addressed-command parser and STOP stay as the deterministic
   override for safety.
5. **Perception** (future): a back-camera person detector on-device (the front-camera face
   module `local-face-attention` is the template), producing target observations with
   bearing and distance estimates.

## Rules that do not change

- Every wheel move goes through `runBoundedMotion` with cliff, near-edge, TOF and deadman
  interlocks. Behaviours widen durations and allow translation; they never bypass this.
- STOP and addressed commands beat everything and cancel behaviours.
- The model never gets a raw driving tool; it expresses intent, the app decides.
- Choreography stays net-zero on heading so behaviours that care about bearing are not
  disturbed by expressive motion.

## What to build first when this resumes

1. Make ambient motion and camera attention read the motion policy.
2. Explore behaviour on the floor, time-boxed, with a settings toggle and diagnostics.
3. `explore` / `stop_behaviour` intent tools; test "go have a look around" in plain speech.
4. Back-camera person detection spike; then follow, then flee.

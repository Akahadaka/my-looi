# My LOOI User Guide

This guide covers the public **My LOOI v2.1.151** Android source line.

My LOOI is an unofficial, community-developed Android companion for the LOOI robot. It combines Realtime voice conversation, local memory, multilingual interaction, configurable robot commands, explicit visual look, local-only Camera Attention, appearance options, and safety-bounded BLE control.

## 1. What you need

- A compatible Android phone mounted on or used with the LOOI robot.
- The My LOOI APK.
- Bluetooth enabled.
- An OpenAI API key for Realtime conversation.
- Microphone permission.
- Camera permission when Camera Attention or an explicit visual-look command is used.

The OpenAI API key is entered inside the app and stored with Android SecureStore. Do not put API keys into source files or share them in diagnostics.

## 2. First setup

1. Open **Settings**.
2. Choose the **Interface language**, **Listening language**, and **Response language**. They are independent.
3. Enter and save your **OpenAI API key**.
4. Refresh the available Realtime models and choose a model.
5. Choose a Realtime voice and use the preview button if desired. You can also choose the independent **Speech grammatical gender** used when LOOI refers to itself in Russian/Ukrainian.
6. In **Robot**, scan for your LOOI and save/connect it.
7. Optionally configure the robot name, command aliases, natural motion, Camera Attention, appearance, backup folder, and custom phrases.

The interface, listening, and response languages support **Ukrainian, English and Russian**.

## 3. OpenAI API status and billing

**Settings → OpenAI** shows the last known API state next to the saved key. My LOOI can report states such as a valid key, a successfully working Realtime session, rejected credentials, or exhausted prepaid credits.

A normal project API key does not expose the exact prepaid dollar balance to the app. Use **Open OpenAI Billing** in Settings to view the authoritative balance and add credits. If OpenAI returns `credit_balance_exhausted`, My LOOI also shows a visible error on the main face instead of silently appearing unresponsive.

## 4. Normal conversation

The primary conversation mode is **Realtime PCM**. My LOOI owns microphone capture and playback directly and supports natural interruption: if you start speaking while the assistant is talking, playback can be interrupted and the unheard portion of the reply is truncated from conversation state.

You can talk naturally, ask follow-up questions, request translations or pronunciation, and ask the assistant to switch the default response language. Ordinary conversation does not require saying the robot name first.

### Speech grammatical gender

In **Settings → LOOI voice**, choose **Masculine** or **Feminine** grammatical self-reference independently from the OpenAI voice and visual character. This mainly affects languages such as Russian and Ukrainian: for example, LOOI can say `я увидел` / `я побачив` or `я увидела` / `я побачила`. This setting describes LOOI's own speech only; it does not infer the human user's gender.

## 5. Robot name and addressing

The robot has a configurable **primary spoken name**. You can also add normal address aliases and narrower speech-recognition aliases in **Settings → Voice Commands**.

Common built-in robot addresses include **LOOI / Луи / Луї / Макс / Max / Robot / Робот**. Configured aliases are names of the robot, not names of the human user.

For safety, deterministic physical commands normally require the robot address at the beginning of the utterance. Emergency STOP is the exception.

## 6. Built-in physical voice commands

Representative examples include:

| Action | Russian | Ukrainian | English |
| --- | --- | --- | --- |
| Emergency stop | `Стоп`, `Луи, остановись` | `Стоп`, `Луї, зупинись` | `Stop`, `LOOI, halt` |
| Forward | `Луи, вперёд` | `Луї, вперед` | `LOOI, forward` |
| Backward | `Луи, назад` | `Луї, назад` | `LOOI, backward` |
| Left | `Луи, поверни налево` | `Луї, поверни вліво` | `LOOI, turn left` |
| Right | `Луи, поверни направо` | `Луї, поверни вправо` | `LOOI, turn right` |
| Turn around | `Луи, развернись` | `Луї, розвернись` | `LOOI, turn around` |
| Nod | `Луи, кивни` | `Луї, кивни` | `LOOI, nod` |
| Dance | `Луи, потанцуй` | `Луї, потанцюй` | `LOOI, dance` |
| Sleep | `Луи, иди спать` | `Луї, іди спати` | `LOOI, go to sleep` |

**`Стоп` / `Stop` is a universal safety command and does not require the robot name.** Movement remains bounded by the existing BLE/deadman/cliff safety path.

## 7. Custom voice phrases

Open **Settings → Voice Commands → Custom phrases**. The section is collapsed by default and shows the configured phrase count.

Custom phrases can be tagged as **UK**, **EN**, or **RU**. Physical actions still route through the same deterministic parser and protected executor. The phrase tester checks parsing only and does not move the robot or take a photograph.

The visual action **Look here / see this** can also have custom language-tagged phrases. Like the built-in visual action, it still requires an explicit robot address.

## 8. Explicit visual look

You can explicitly show LOOI a page, package, label, object, diagram, or other visual content and continue discussing it by voice.

Examples:

- `Луи, посмотри сюда.`
- `Бобик, смотри, что я показываю.`
- `Луи, посмотри на эту страницу.`
- `Бобик, прочитай, что здесь написано.`
- `LOOI, look at this.`

A visual request must start with the robot name or an accepted robot alias. Broad unaddressed phrases such as just `смотри` do not trigger cloud image capture.

### Front and rear camera

The **front camera is the default** because it points toward the person interacting with a phone mounted on LOOI.

For fine text or a document that is easier to aim with the main phone camera, explicitly request the rear camera, for example:

- `Бобик, посмотри задней камерой.`
- `Луи, сфотографируй это задней камерой.`
- `LOOI, look at this with the rear camera.`

My LOOI selects a suitable rear camera through Android Camera2 instead of relying on a hard-coded camera ID. It prefers a normal autofocus-capable rear camera when the device exposes several rear sensors.

### Image quality and light

Explicit-look capture uses a higher-resolution JPEG than the local Camera Attention analysis stream. The app lets Camera2 auto-exposure and auto-white-balance settle before a newly opened camera takes the still. Rear-camera capture may use automatic flash when the selected camera reports flash capability.

Diagnostic metadata can include the camera side, image dimensions, AF/AE/AWB state, exposure time, ISO and a low-light hint. The image bytes themselves are not written to diagnostics.

For tiny packaging text, use the rear camera when practical, fill a useful part of the frame, avoid glare, and provide enough light. If the visible text is genuinely unreadable, LOOI should say so rather than inventing it.

### Privacy of explicit visual look

The still is captured in memory and sent to the **current OpenAI Realtime conversation** only after an explicit addressed visual request. My LOOI does not write the snapshot to its own photo files or diagnostic archive. The newest image remains conversation context for follow-up questions until the conversation context changes.

### Choose photos from Android Photo Picker

Tap the small **photo/gallery icon** on LOOI's face to open Android Photo Picker. You can choose **up to four** existing images. Android grants My LOOI scoped access only to the photos you explicitly select; My LOOI does not request permission to browse the whole gallery. My LOOI reads those selected images immediately after the picker returns and may temporarily persist the scoped read grant for those exact selections when Android/provider support is available; the grant is released when the photos have been prepared and sent into the discussion.

After you return, the selected images are added to the current Realtime discussion in selection order as photo 1, photo 2, and so on. You can then continue naturally by voice, for example: `what is on the first photo?`, `compare the first and second`, or `read the text on the second photo`.

Opening the system picker temporarily backgrounds My LOOI. Sensitive microphone/BLE/Realtime runtime is still suspended while the picker is open, but the app uses an explicit external-activity lease so the normal five-second background process kill does not terminate the selection flow. When My LOOI returns, it reseeds a bounded recent text transcript and then adds the selected photos before continuing the discussion.

Selected photos are temporary conversation context. They are converted in memory for Realtime, are not copied into durable My LOOI storage, are not added to diagnostics, and are not written into long-term memory automatically.

## 9. Sleep and wake

An addressed sleep command puts LOOI into the app sleep state with a visibly sleeping face. Manual wake uses a **single tap on the face**.

## 10. Natural motion

In **Settings → Robot → Natural motion**, choose Off, Subtle, Normal, or Lively. Actual human speech and explicit commands take priority. Ambient body motion stays small and safety-bounded.

## 11. Camera Attention

**Camera Attention** is optional and off by default. During an active interaction it can detect a visible face locally, direct the on-screen eyes toward it, make bounded head/body recentering corrections, and perform a finite search when appropriate.

Camera Attention is not permanent surveillance and does not autonomously drive forward toward a person. Its face-analysis frames remain local in memory and are not uploaded by My LOOI. This is separate from the explicit user-requested visual still described above.

## 12. Face appearance

Open **Settings → Appearance** to choose a face style and color palette independently. Current styles include Classic, Soft, Playful, Cap, Cowboy, Bandana and Sharp.


## 13. Memory and history

Conversation history and durable extracted facts are stored locally in SQLite. Realtime sessions can preload bounded relevant memory and use targeted local search for deeper recall. My LOOI does not require a companion backend for normal operation.

## 14. Backup and restore

Open **Settings → Advanced → Memory and backup**, then select a folder through Android's system document picker. You can create a backup, restore it, or forget/change the selected folder.

## 15. Diagnostics

Open **Settings → Advanced → Diagnostics** to share a diagnostic ZIP, choose a persistent SAF folder and save diagnostics there, or clear diagnostic events.

Normal diagnostics do not retain microphone WAV recordings or visual-look image bytes. When reporting a reproducible problem, export diagnostics immediately after the test.

## 16. Updates

My LOOI can check GitHub Releases from **Settings → Updates**, verify the expected package/version/checksum/signing identity, and hand the APK to Android's installer.

## 17. Privacy summary

- OpenAI Realtime audio is sent to OpenAI only while a Realtime conversation is active.
- The OpenAI API key is stored in Android SecureStore.
- Conversation history and durable memory are local by default.
- Backgrounding the app or turning the screen off triggers a hard sensitive-runtime suspend.
- Camera Attention face-analysis frames remain local-only.
- An explicit visual-look still is sent only after an addressed user request and is not stored by My LOOI as a photo or diagnostic payload.
- Diagnostic export is manual and user-triggered.

See `PRIVACY.md` for the detailed privacy policy.

## 18. Safety summary

- Say **`Стоп` / `Stop`** at any time for the emergency STOP path.
- Address ordinary physical commands explicitly.
- Movement remains bounded and protected by BLE/deadman/cliff checks.
- Explicit visual look does not grant the LLM unrestricted movement control.
- Camera Attention never adds autonomous forward/backward person-following.
- The custom-phrase test checks parsing only and never moves the robot or captures an image.

---

My LOOI is community-developed and is not affiliated with or endorsed by the LOOI robot manufacturer.

## Performance diagnostics

Diagnostic ZIP exports include performance/memory snapshots and previous Android process-exit reasons when supported. This is intended to help diagnose freezes, ANRs and low-memory kills even when ADB is unavailable.

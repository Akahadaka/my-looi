package com.superlooi.stereomicprobe

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.MicrophoneInfo
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
import android.os.Process
import android.os.SystemClock
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.ceil
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Developer diagnostic: does this phone give true stereo from its two built-in
 * microphones, does that survive a concurrent VOICE_COMMUNICATION + AEC mono
 * capture (the conversation pipeline), and is a GCC-PHAT bearing stable?
 *
 * Bearing sign convention (used by every `bearingDeg` / `tdoa*` value):
 * the time difference is the delay of the LEFT channel relative to the RIGHT
 * channel (channel 0 = left, channel 1 = right in the interleaved AudioRecord
 * data). A POSITIVE tdoa/bearing means sound reached the RIGHT channel first,
 * i.e. the source is on the right-channel side. Zero is straight ahead and
 * +/-90 degrees is end-fire along the microphone axis. Which physical side of
 * the robot "right channel" is depends on the phone orientation, so the
 * screen offers a left/right calibration step.
 *
 * bearing = asin(clamp(tdoa * 343 / micSpacing, -1, 1)), in degrees.
 */
class StereoMicProbeModule : Module() {
  companion object {
    private const val WINDOW_FRAMES = 2048
    private const val HOP_FRAMES = WINDOW_FRAMES / 2
    private const val FFT_SIZE = 4096
    private const val SPEED_OF_SOUND_MPS = 343.0
    private const val DEFAULT_SAMPLE_RATE = 48_000
    private const val DEFAULT_MIC_SPACING_M = 0.15
    private const val CONVERSATION_RATE = 16_000
    private const val CONVERSATION_CHUNK_FRAMES = 640 // 40 ms @ 16 kHz, as RealtimePcmAudioModule
    private const val BYTES_PER_SAMPLE = 2
    private const val EMIT_INTERVAL_MS = 100L
    private const val SILENCE_POLL_MS = 500L
    private const val VOICE_MARGIN_DB = 9.0
    private const val VOICE_MIN_ABSOLUTE_DB = -70.0
    private const val NOISE_FLOOR_RISE_DB_PER_SECOND = 0.5
    private const val NOISE_FLOOR_MAX_AGE_MS = 120_000L
    private const val MIN_PEAK_RATIO = 3.0
    private const val LEVEL_FLOOR_DB = -120.0
    private const val MAX_CONSECUTIVE_READ_ERRORS = 25

    /** Noise floors survive stop/start so a matrix run does not re-learn it while the user is already speaking. */
    private val noiseFloors = ConcurrentHashMap<String, Pair<Double, Long>>()
  }

  @Volatile private var session: ProbeSession? = null

  override fun definition() = ModuleDefinition {
    Name("StereoMicProbe")
    Events("onProbeFrame", "onProbeError", "onProbeStarted", "onProbeStopped")

    AsyncFunction("getCapabilities") { getCapabilities() }
    AsyncFunction("start") { options: Map<String, Any?> -> startProbe(options) }
    AsyncFunction("stop") { stopProbeAndStatus() }
    Function("getStatus") { status() }

    OnDestroy {
      stopProbe("module-destroyed")
    }
  }

  private fun context(): Context = appContext.reactContext?.applicationContext
    ?: throw IllegalStateException("Android application context is unavailable")

  private fun emit(name: String, body: Map<String, Any?>) {
    // Events can race module teardown; diagnostics must never crash the app.
    try { sendEvent(name, body) } catch (_: Throwable) {}
  }

  private fun emitError(stage: String, message: String, fatal: Boolean = false) {
    emit("onProbeError", mapOf("stage" to stage, "message" to message, "fatal" to fatal))
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  private fun getCapabilities(): Map<String, Any?> {
    val context = context()
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val microphones = readMicrophones(audioManager)
    val inputDevices = try {
      audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).map { device ->
        mapOf(
          "type" to deviceTypeName(device.type),
          "productName" to device.productName?.toString(),
          "address" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) device.address else null,
          "channelCounts" to device.channelCounts.toList(),
          "sampleRates" to device.sampleRates.toList()
        )
      }
    } catch (_: Throwable) {
      emptyList()
    }
    val unprocessed = try {
      audioManager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
    } catch (_: Throwable) {
      false
    }
    return mapOf(
      "microphones" to microphones.map { micToMap(it) },
      "inputDevices" to inputDevices,
      "unprocessedSupported" to unprocessed,
      "estimatedMicSpacingM" to estimateMicSpacing(microphones),
      "sdkInt" to Build.VERSION.SDK_INT,
      "manufacturer" to Build.MANUFACTURER,
      "model" to Build.MODEL
    )
  }

  private fun readMicrophones(audioManager: AudioManager): List<MicrophoneInfo> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return emptyList()
    return try {
      audioManager.microphones
    } catch (_: Throwable) {
      emptyList()
    }
  }

  private fun positionOf(info: MicrophoneInfo): DoubleArray? {
    val position = info.position ?: return null
    val unknown = MicrophoneInfo.POSITION_UNKNOWN
    val values = doubleArrayOf(position.x.toDouble(), position.y.toDouble(), position.z.toDouble())
    if (position.x == unknown.x && position.y == unknown.y && position.z == unknown.z) return null
    // Guard against vendor builds that hand back a different sentinel.
    if (values.any { !it.isFinite() || abs(it) > 100.0 }) return null
    return values
  }

  private fun orientationOf(info: MicrophoneInfo): DoubleArray? {
    val orientation = info.orientation ?: return null
    val values = doubleArrayOf(orientation.x.toDouble(), orientation.y.toDouble(), orientation.z.toDouble())
    if (values.any { !it.isFinite() || abs(it) > 100.0 }) return null
    if (values.all { it == 0.0 }) return null
    return values
  }

  private fun vectorMap(values: DoubleArray?): Map<String, Any?>? =
    values?.let { mapOf("x" to it[0], "y" to it[1], "z" to it[2]) }

  private fun micToMap(info: MicrophoneInfo): Map<String, Any?> = mapOf(
    "id" to info.id,
    "description" to info.description,
    "type" to deviceTypeName(info.type),
    "address" to info.address,
    "location" to when (info.location) {
      MicrophoneInfo.LOCATION_MAINBODY -> "MAINBODY"
      MicrophoneInfo.LOCATION_MAINBODY_MOVABLE -> "MAINBODY_MOVABLE"
      MicrophoneInfo.LOCATION_PERIPHERAL -> "PERIPHERAL"
      else -> "UNKNOWN"
    },
    "position" to vectorMap(positionOf(info)),
    "orientation" to vectorMap(orientationOf(info)),
    "directionality" to when (info.directionality) {
      MicrophoneInfo.DIRECTIONALITY_OMNI -> "OMNI"
      MicrophoneInfo.DIRECTIONALITY_BI_DIRECTIONAL -> "BI_DIRECTIONAL"
      MicrophoneInfo.DIRECTIONALITY_CARDIOID -> "CARDIOID"
      MicrophoneInfo.DIRECTIONALITY_HYPER_CARDIOID -> "HYPER_CARDIOID"
      MicrophoneInfo.DIRECTIONALITY_SUPER_CARDIOID -> "SUPER_CARDIOID"
      else -> "UNKNOWN"
    }
  )

  /** Largest distance (metres) between two built-in microphones whose positions are both known. */
  private fun estimateMicSpacing(microphones: List<MicrophoneInfo>): Double? {
    val positions = microphones
      .filter { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }
      .mapNotNull { positionOf(it) }
    var best: Double? = null
    for (first in positions.indices) {
      for (second in first + 1 until positions.size) {
        val dx = positions[first][0] - positions[second][0]
        val dy = positions[first][1] - positions[second][1]
        val dz = positions[first][2] - positions[second][2]
        val distance = sqrt(dx * dx + dy * dy + dz * dz)
        if (distance > 0.0 && (best == null || distance > best)) best = distance
      }
    }
    return best
  }

  private fun deviceTypeName(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "BUILTIN_MIC"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "BUILTIN_EARPIECE"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
    AudioDeviceInfo.TYPE_TELEPHONY -> "TELEPHONY"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "WIRED_HEADPHONES"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
    AudioDeviceInfo.TYPE_USB_DEVICE -> "USB_DEVICE"
    AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB_ACCESSORY"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "USB_HEADSET"
    AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "REMOTE_SUBMIX"
    AudioDeviceInfo.TYPE_FM_TUNER -> "FM_TUNER"
    AudioDeviceInfo.TYPE_BUS -> "BUS"
    else -> "TYPE_$type"
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  private class ProbeConfig(
    val sourceName: String,
    val sourceId: Int,
    val sampleRate: Int,
    val simulateConversation: Boolean,
    val micSpacingM: Double
  )

  private fun parseOptions(options: Map<String, Any?>): ProbeConfig {
    val sourceName = (options["source"] as? String) ?: "VOICE_COMMUNICATION"
    val sourceId = when (sourceName) {
      "VOICE_COMMUNICATION" -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
      "UNPROCESSED" -> MediaRecorder.AudioSource.UNPROCESSED
      "CAMCORDER" -> MediaRecorder.AudioSource.CAMCORDER
      "MIC" -> MediaRecorder.AudioSource.MIC
      "VOICE_RECOGNITION" -> MediaRecorder.AudioSource.VOICE_RECOGNITION
      else -> throw IllegalArgumentException("Unsupported audio source: $sourceName")
    }
    val sampleRate = (options["sampleRate"] as? Number)?.toInt() ?: DEFAULT_SAMPLE_RATE
    if (sampleRate < 8_000 || sampleRate > 96_000) {
      throw IllegalArgumentException("Unsupported sample rate: $sampleRate")
    }
    val simulate = (options["simulateConversationCapture"] as? Boolean) ?: false
    val requestedSpacing = (options["micSpacingM"] as? Number)?.toDouble()?.takeIf { it.isFinite() && it > 0.0 }
    val spacing = requestedSpacing
      ?: estimateMicSpacing(readMicrophones(context().getSystemService(Context.AUDIO_SERVICE) as AudioManager))
      ?: DEFAULT_MIC_SPACING_M
    return ProbeConfig(sourceName, sourceId, sampleRate, simulate, spacing)
  }

  @Synchronized private fun startProbe(options: Map<String, Any?>): Map<String, Any?> {
    stopProbe("restart")
    val context = context()
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      emitError("permission", "RECORD_AUDIO permission is required", fatal = true)
      throw SecurityException("RECORD_AUDIO permission is required")
    }
    val config = try {
      parseOptions(options)
    } catch (error: Throwable) {
      emitError("options", error.message ?: error.javaClass.simpleName, fatal = true)
      throw error
    }

    val created = ProbeSession(config)
    try {
      val started = created.open()
      session = created
      emit("onProbeStarted", started)
      created.begin()
      return started
    } catch (error: Throwable) {
      created.shutdown()
      session = null
      throw error
    }
  }

  @Synchronized private fun stopProbe(reason: String): Boolean {
    val current = session ?: return false
    session = null
    current.shutdown()
    emit("onProbeStopped", mapOf(
      "reason" to reason,
      "framesRead" to current.framesRead.get(),
      "readErrors" to current.readErrors.get()
    ))
    return true
  }

  private fun stopProbeAndStatus(): Map<String, Any?> {
    stopProbe("requested")
    return status()
  }

  private fun status(): Map<String, Any?> {
    val current = session
    val granted = appContext.reactContext?.let {
      ContextCompat.checkSelfPermission(it, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    } ?: false
    return mapOf(
      "supported" to true,
      "running" to (current != null && current.running.get()),
      "permissionGranted" to granted,
      "source" to current?.config?.sourceName,
      "sampleRate" to current?.stereoSampleRate,
      "channelCount" to current?.stereoChannelCount,
      "simulateConversationCapture" to (current?.config?.simulateConversation ?: false),
      "framesRead" to (current?.framesRead?.get() ?: 0L),
      "readErrors" to (current?.readErrors?.get() ?: 0L)
    )
  }

  // ---------------------------------------------------------------------------
  // Capture session
  // ---------------------------------------------------------------------------

  private class AecHandle(
    val available: Boolean,
    val effect: AcousticEchoCanceler?,
    val enabled: Boolean,
    val error: String?
  ) {
    fun toMap(): Map<String, Any?> = mapOf(
      "available" to available,
      "attached" to (effect != null),
      "enabled" to enabled,
      "error" to error
    )

    fun release() {
      try { effect?.release() } catch (_: Throwable) {}
    }
  }

  private class WindowResult(
    val rmsLeft: Double,
    val rmsRight: Double,
    val correlation: Double,
    val identical: Boolean,
    val tdoaSamples: Double,
    val tdoaUs: Double,
    val bearingDeg: Double,
    val peakRatio: Double,
    val voiceActive: Boolean
  )

  private fun toDb(rms: Double): Double = if (rms < 1e-6) LEVEL_FLOOR_DB else max(LEVEL_FLOOR_DB, 20.0 * log10(rms))

  private fun median(values: List<Double>): Double {
    val sorted = values.sorted()
    val middle = sorted.size / 2
    return if (sorted.size % 2 == 1) sorted[middle] else (sorted[middle - 1] + sorted[middle]) / 2.0
  }

  private fun silencedOf(record: AudioRecord?): Boolean? {
    if (record == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    return try {
      record.activeRecordingConfiguration?.isClientSilenced
    } catch (_: Throwable) {
      null
    }
  }

  private fun routedDeviceMap(record: AudioRecord): Map<String, Any?>? {
    return try {
      val device = record.routedDevice ?: return null
      mapOf(
        "type" to deviceTypeName(device.type),
        "productName" to device.productName?.toString(),
        "address" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) device.address else null,
        "id" to device.id
      )
    } catch (_: Throwable) {
      null
    }
  }

  private fun attachEchoCanceler(sessionId: Int): AecHandle {
    if (!AcousticEchoCanceler.isAvailable()) return AecHandle(false, null, false, null)
    val effect = try {
      AcousticEchoCanceler.create(sessionId)
    } catch (error: Throwable) {
      return AecHandle(true, null, false, error.message ?: error.javaClass.simpleName)
    } ?: return AecHandle(true, null, false, "AcousticEchoCanceler.create returned null")
    return try {
      effect.setEnabled(true)
      AecHandle(true, effect, effect.getEnabled(), null)
    } catch (error: Throwable) {
      try { effect.release() } catch (_: Throwable) {}
      AecHandle(true, null, false, error.message ?: error.javaClass.simpleName)
    }
  }

  /** Builds an AudioRecord and moves it to RECORDING, releasing it again on any failure. */
  private fun openAndStart(source: Int, format: AudioFormat, bufferBytes: Int): AudioRecord {
    val record = AudioRecord.Builder()
      .setAudioSource(source)
      .setAudioFormat(format)
      .setBufferSizeInBytes(bufferBytes)
      .build()
    try {
      if (record.state != AudioRecord.STATE_INITIALIZED) {
        throw IllegalStateException("AudioRecord state=${record.state}")
      }
      record.startRecording()
      if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        throw IllegalStateException("AudioRecord did not enter RECORDSTATE_RECORDING")
      }
    } catch (error: Throwable) {
      try { record.release() } catch (_: Throwable) {}
      throw error
    }
    return record
  }

  private inner class ProbeSession(val config: ProbeConfig) {
    val running = AtomicBoolean(false)
    val framesRead = AtomicLong(0)
    val readErrors = AtomicLong(0)
    val conversationFramesRead = AtomicLong(0)

    @Volatile var stereoSampleRate = config.sampleRate
    @Volatile var stereoChannelCount = 2
    @Volatile private var stereoSilenced: Boolean? = null
    @Volatile private var conversationSilenced: Boolean? = null

    private var stereoRecord: AudioRecord? = null
    private var stereoAec: AecHandle? = null
    private var conversationRecord: AudioRecord? = null
    private var conversationAec: AecHandle? = null
    private var stereoThread: Thread? = null
    private var conversationThread: Thread? = null

    private val conversationLock = Any()
    private var conversationSumSquares = 0.0
    private var conversationSampleCount = 0L

    private fun fail(stage: String, message: String): Nothing {
      emitError(stage, message, fatal = true)
      throw IllegalStateException(message)
    }

    /** Opens the records and returns the started payload. Does not begin reading. */
    fun open(): Map<String, Any?> {
      // The conversation pipeline is already live in real use and the stereo
      // capture would join it, so open that one first when simulating.
      if (config.simulateConversation) openConversation()
      openStereo()

      val record = stereoRecord!!
      val format = record.format
      stereoChannelCount = format.channelCount
      stereoSampleRate = format.sampleRate
      return mapOf(
        "source" to config.sourceName,
        "requestedSampleRate" to config.sampleRate,
        "sampleRate" to stereoSampleRate,
        "requestedChannelCount" to 2,
        "channelCount" to stereoChannelCount,
        "audioSessionId" to record.audioSessionId,
        "micSpacingM" to config.micSpacingM,
        "routedDevice" to routedDeviceMap(record),
        "aec" to stereoAec?.toMap(),
        "simulateConversationCapture" to config.simulateConversation,
        "conversation" to conversationRecord?.let {
          mapOf(
            "sampleRate" to CONVERSATION_RATE,
            "channelCount" to 1,
            "routedDevice" to routedDeviceMap(it),
            "aec" to conversationAec?.toMap()
          )
        }
      )
    }

    private fun openConversation() {
      val minBuffer = AudioRecord.getMinBufferSize(
        CONVERSATION_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )
      if (minBuffer <= 0) fail("open-conversation", "Conversation AudioRecord minimum buffer query failed: $minBuffer")
      val bufferBytes = max(minBuffer * 2, CONVERSATION_CHUNK_FRAMES * BYTES_PER_SAMPLE * 4)
      val format = AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(CONVERSATION_RATE)
        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
        .build()
      val record = try {
        openAndStart(MediaRecorder.AudioSource.VOICE_COMMUNICATION, format, bufferBytes)
      } catch (error: Throwable) {
        fail(
          "open-conversation",
          "Conversation VOICE_COMMUNICATION 16 kHz mono capture failed: ${error.message ?: error.javaClass.simpleName}"
        )
      }
      conversationRecord = record
      // Same ordering as RealtimePcmAudioModule: attach AEC to the live session.
      conversationAec = attachEchoCanceler(record.audioSessionId)
    }

    private fun openStereo() {
      val minBuffer = AudioRecord.getMinBufferSize(
        config.sampleRate,
        AudioFormat.CHANNEL_IN_STEREO,
        AudioFormat.ENCODING_PCM_16BIT
      )
      if (minBuffer <= 0) {
        fail("open-stereo", "Stereo capture is not supported at ${config.sampleRate} Hz (getMinBufferSize=$minBuffer)")
      }
      val bufferBytes = max(minBuffer * 2, HOP_FRAMES * 2 * BYTES_PER_SAMPLE * 4)
      val format = AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(config.sampleRate)
        .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
        .build()
      val record = try {
        openAndStart(config.sourceId, format, bufferBytes)
      } catch (error: Throwable) {
        fail(
          "open-stereo",
          "${config.sourceName} stereo ${config.sampleRate} Hz capture failed: ${error.message ?: error.javaClass.simpleName}"
        )
      }
      stereoRecord = record
      stereoAec = attachEchoCanceler(record.audioSessionId)
    }

    fun begin() {
      running.set(true)
      conversationRecord?.let { record ->
        conversationThread = Thread({ conversationLoop(record) }, "StereoMicProbe-conversation").also { it.start() }
      }
      stereoRecord?.let { record ->
        stereoThread = Thread({ stereoLoop(record) }, "StereoMicProbe-capture").also { it.start() }
      }
    }

    fun shutdown() {
      running.set(false)
      // Stopping the records first unblocks any read() in the capture threads.
      try { stereoRecord?.stop() } catch (_: Throwable) {}
      try { conversationRecord?.stop() } catch (_: Throwable) {}
      try { stereoThread?.join(500) } catch (_: Throwable) {}
      try { conversationThread?.join(500) } catch (_: Throwable) {}
      stereoAec?.release()
      conversationAec?.release()
      try { stereoRecord?.release() } catch (_: Throwable) {}
      try { conversationRecord?.release() } catch (_: Throwable) {}
      stereoRecord = null
      conversationRecord = null
      stereoAec = null
      conversationAec = null
    }

    // -- conversation (mono, 16 kHz) ------------------------------------------

    private fun conversationLoop(record: AudioRecord) {
      try {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val pcm = ShortArray(CONVERSATION_CHUNK_FRAMES)
        var consecutiveErrors = 0
        var lastSilencePollAt = 0L
        while (running.get()) {
          val read = record.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
          if (read <= 0) {
            if (!running.get()) break
            readErrors.incrementAndGet()
            if (++consecutiveErrors >= MAX_CONSECUTIVE_READ_ERRORS) {
              emitError("conversation-read", "Conversation AudioRecord.read kept failing (last=$read)", fatal = true)
              break
            }
            Thread.sleep(10)
            continue
          }
          consecutiveErrors = 0
          var sumSquares = 0.0
          for (index in 0 until read) {
            val value = pcm[index] / 32768.0
            sumSquares += value * value
          }
          synchronized(conversationLock) {
            conversationSumSquares += sumSquares
            conversationSampleCount += read
          }
          conversationFramesRead.addAndGet(read.toLong())
          val now = SystemClock.elapsedRealtime()
          if (now - lastSilencePollAt >= SILENCE_POLL_MS) {
            lastSilencePollAt = now
            conversationSilenced = silencedOf(record)
          }
        }
      } catch (error: Throwable) {
        if (running.get()) emitError("conversation-loop", error.message ?: error.javaClass.simpleName, fatal = true)
      }
    }

    /** Mean-square level of the conversation capture since the previous call, in dBFS. */
    private fun drainConversationLevelDb(): Double {
      val sumSquares: Double
      val count: Long
      synchronized(conversationLock) {
        sumSquares = conversationSumSquares
        count = conversationSampleCount
        conversationSumSquares = 0.0
        conversationSampleCount = 0
      }
      return if (count <= 0L) LEVEL_FLOOR_DB else toDb(sqrt(sumSquares / count))
    }

    // -- stereo ---------------------------------------------------------------

    private fun stereoLoop(record: AudioRecord) {
      try {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val rate = stereoSampleRate
        val channels = max(1, stereoChannelCount)
        val hop = ShortArray(HOP_FRAMES * channels)
        val left = DoubleArray(WINDOW_FRAMES)
        val right = DoubleArray(WINDOW_FRAMES)
        val estimator = GccPhatEstimator(WINDOW_FRAMES, FFT_SIZE)
        val maxLag = ceil(config.micSpacingM / SPEED_OF_SOUND_MPS * rate).toInt() + 2
        val hopSeconds = HOP_FRAMES.toDouble() / rate

        val floorKey = "${config.sourceName}@$rate"
        var noiseFloorDb = Double.NaN
        noiseFloors[floorKey]?.let { (value, at) ->
          if (SystemClock.elapsedRealtime() - at <= NOISE_FLOOR_MAX_AGE_MS) noiseFloorDb = value
        }

        val pending = ArrayList<WindowResult>()
        var filled = 0
        var consecutiveErrors = 0
        var lastEmitAt = SystemClock.elapsedRealtime()
        var lastSilencePollAt = 0L

        while (running.get()) {
          var got = 0
          while (got < hop.size && running.get()) {
            val read = record.read(hop, got, hop.size - got, AudioRecord.READ_BLOCKING)
            if (read > 0) {
              got += read
              consecutiveErrors = 0
            } else {
              if (!running.get()) break
              readErrors.incrementAndGet()
              if (++consecutiveErrors >= MAX_CONSECUTIVE_READ_ERRORS) {
                emitError("stereo-read", "Stereo AudioRecord.read kept failing (last=$read)", fatal = true)
                return
              }
              Thread.sleep(10)
            }
          }
          if (got < hop.size) continue
          framesRead.addAndGet(HOP_FRAMES.toLong())

          System.arraycopy(left, HOP_FRAMES, left, 0, WINDOW_FRAMES - HOP_FRAMES)
          System.arraycopy(right, HOP_FRAMES, right, 0, WINDOW_FRAMES - HOP_FRAMES)
          val offset = WINDOW_FRAMES - HOP_FRAMES
          for (frame in 0 until HOP_FRAMES) {
            val base = frame * channels
            left[offset + frame] = hop[base] / 32768.0
            right[offset + frame] = if (channels >= 2) hop[base + 1] / 32768.0 else hop[base] / 32768.0
          }
          filled += HOP_FRAMES
          if (filled < WINDOW_FRAMES) continue

          val result = analyseWindow(left, right, channels >= 2, estimator, maxLag, rate, noiseFloorDb)
          pending.add(result)
          noiseFloorDb = nextNoiseFloor(noiseFloorDb, max(toDb(result.rmsLeft), toDb(result.rmsRight)), hopSeconds)

          val now = SystemClock.elapsedRealtime()
          if (now - lastSilencePollAt >= SILENCE_POLL_MS) {
            lastSilencePollAt = now
            stereoSilenced = silencedOf(record)
          }
          if (now - lastEmitAt >= EMIT_INTERVAL_MS) {
            lastEmitAt = now
            if (!noiseFloorDb.isNaN()) noiseFloors[floorKey] = Pair(noiseFloorDb, now)
            emitFrame(pending, noiseFloorDb)
            pending.clear()
          }
        }
      } catch (error: Throwable) {
        if (running.get()) emitError("stereo-loop", error.message ?: error.javaClass.simpleName, fatal = true)
      }
    }

    /** Slow minimum follower: falls immediately to a new minimum, rises at 0.5 dB per second. */
    private fun nextNoiseFloor(current: Double, level: Double, hopSeconds: Double): Double {
      if (current.isNaN() || level < current) return level
      return minOf(level, current + NOISE_FLOOR_RISE_DB_PER_SECOND * hopSeconds)
    }

    private fun analyseWindow(
      left: DoubleArray,
      right: DoubleArray,
      stereo: Boolean,
      estimator: GccPhatEstimator,
      maxLag: Int,
      rate: Int,
      noiseFloorDb: Double
    ): WindowResult {
      var sumLeft = 0.0
      var sumRight = 0.0
      var energyLeft = 0.0
      var energyRight = 0.0
      var exactlyEqual = true
      for (index in 0 until WINDOW_FRAMES) {
        val l = left[index]
        val r = right[index]
        sumLeft += l
        sumRight += r
        energyLeft += l * l
        energyRight += r * r
        if (l != r) exactlyEqual = false
      }
      val rmsLeft = sqrt(energyLeft / WINDOW_FRAMES)
      val rmsRight = sqrt(energyRight / WINDOW_FRAMES)
      val meanLeft = sumLeft / WINDOW_FRAMES
      val meanRight = sumRight / WINDOW_FRAMES

      var covLeft = 0.0
      var covRight = 0.0
      var covCross = 0.0
      for (index in 0 until WINDOW_FRAMES) {
        val l = left[index] - meanLeft
        val r = right[index] - meanRight
        covLeft += l * l
        covRight += r * r
        covCross += l * r
      }
      val correlation = if (covLeft > 1e-12 && covRight > 1e-12) covCross / sqrt(covLeft * covRight) else 0.0

      val leftDb = toDb(rmsLeft)
      val rightDb = toDb(rmsRight)
      val hasEnergy = energyLeft > 1e-12 || energyRight > 1e-12
      val identical = stereo && hasEnergy &&
        (exactlyEqual || (correlation > 0.9995 && abs(leftDb - rightDb) < 0.1))

      val level = max(leftDb, rightDb)
      val reference = if (noiseFloorDb.isNaN()) level else noiseFloorDb
      val voiceActive = hasEnergy && level > VOICE_MIN_ABSOLUTE_DB && level > reference + VOICE_MARGIN_DB

      var tdoaSamples = 0.0
      var peakRatio = 0.0
      var bearing = 0.0
      var tdoaUs = 0.0
      if (stereo && hasEnergy) {
        val gcc = estimator.estimate(left, right, maxLag)
        tdoaSamples = gcc.tdoaSamples
        peakRatio = gcc.peakRatio
        tdoaUs = tdoaSamples / rate * 1_000_000.0
        val sine = (tdoaSamples / rate * SPEED_OF_SOUND_MPS / config.micSpacingM).coerceIn(-1.0, 1.0)
        bearing = Math.toDegrees(asin(sine))
      }
      return WindowResult(rmsLeft, rmsRight, correlation, identical, tdoaSamples, tdoaUs, bearing, peakRatio, voiceActive)
    }

    private fun emitFrame(windows: List<WindowResult>, noiseFloorDb: Double) {
      if (windows.isEmpty()) return
      val meanSquareLeft = windows.sumOf { it.rmsLeft * it.rmsLeft } / windows.size
      val meanSquareRight = windows.sumOf { it.rmsRight * it.rmsRight } / windows.size
      val voiced = windows.filter { it.voiceActive && it.peakRatio > MIN_PEAK_RATIO }
      val confidenceSource = if (voiced.isNotEmpty()) voiced else windows
      val conversationDb = if (config.simulateConversation) drainConversationLevelDb() else null
      emit("onProbeFrame", mapOf(
        "timestampMs" to System.currentTimeMillis(),
        "rmsL" to toDb(sqrt(meanSquareLeft)),
        "rmsR" to toDb(sqrt(meanSquareRight)),
        "conversationRms" to conversationDb,
        "channelCorrelation" to windows.sumOf { it.correlation } / windows.size,
        "identicalChannels" to windows.any { it.identical },
        "voiceActive" to windows.any { it.voiceActive },
        "bearingDeg" to if (voiced.isNotEmpty()) median(voiced.map { it.bearingDeg }) else null,
        "peakRatio" to confidenceSource.sumOf { it.peakRatio } / confidenceSource.size,
        "tdoaUs" to if (voiced.isNotEmpty()) median(voiced.map { it.tdoaUs }) else null,
        "noiseFloorDb" to if (noiseFloorDb.isNaN()) null else noiseFloorDb,
        "channelCount" to stereoChannelCount,
        "framesRead" to framesRead.get(),
        "readErrors" to readErrors.get(),
        "conversationFramesRead" to if (config.simulateConversation) conversationFramesRead.get() else null,
        "stereoClientSilenced" to stereoSilenced,
        "conversationClientSilenced" to if (config.simulateConversation) conversationSilenced else null
      ))
    }
  }
}

package com.superlooi.gyroyawrecorder

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Surface
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Developer diagnostic for pivot calibration: buffers raw gyroscope samples
 * with their sensor timestamps so JS can integrate LOOI's yaw around a timed
 * wheel pivot without JS timer jitter.
 *
 * Timestamps are milliseconds on the SystemClock.elapsedRealtime clock (the
 * clock SensorEvent.timestamp uses on Android), the same clock as `nowMs()`,
 * so JS can mark "drive started" / "drive stopped" against the samples.
 *
 * Gyroscope axes are the raw device axes in rad/s (right-hand rule, positive
 * is counter-clockwise looking down the axis). The module deliberately does
 * not decide which axis is LOOI's yaw: it also reports the mean "up" vector
 * from TYPE_GRAVITY (accelerometer as a fallback), which reads +g pointing
 * up when the phone is still. JS projects the rotation rate onto that vector,
 * which works for either landscape rotation and any head tilt.
 */
class GyroYawRecorderModule : Module() {
  companion object {
    /** 200 Hz: the fastest rate allowed without HIGH_SAMPLING_RATE_SENSORS on Android 12+. */
    private const val DEFAULT_SAMPLING_PERIOD_US = 5_000
    private const val MIN_SAMPLING_PERIOD_US = 5_000
    /** ~2 minutes at 200 Hz; older samples are dropped if JS stops draining. */
    private const val MAX_BUFFERED_SAMPLES = 24_000
    private const val NANOS_PER_MS = 1_000_000.0
  }

  private class Recording(val thread: HandlerThread, val listener: SensorEventListener)

  private val lock = Any()
  private val tMs = ArrayList<Double>()
  private val gx = ArrayList<Double>()
  private val gy = ArrayList<Double>()
  private val gz = ArrayList<Double>()
  private var droppedSamples = 0
  private var upSumX = 0.0
  private var upSumY = 0.0
  private var upSumZ = 0.0
  private var upCount = 0
  @Volatile private var recording: Recording? = null

  override fun definition() = ModuleDefinition {
    Name("GyroYawRecorder")

    AsyncFunction("getInfo") { info() }
    AsyncFunction("start") { options: Map<String, Any?> -> start(options) }
    AsyncFunction("stop") { stop() }
    Function("drain") { drain() }
    Function("nowMs") { SystemClock.elapsedRealtimeNanos() / NANOS_PER_MS }
    Function("isRecording") { recording != null }

    OnDestroy {
      stop()
    }
  }

  private fun sensorManager(): SensorManager? =
    appContext.reactContext?.applicationContext?.getSystemService(Context.SENSOR_SERVICE) as? SensorManager

  private fun info(): Map<String, Any?> {
    val manager = sensorManager()
    val gyro = manager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    val gravity = manager?.getDefaultSensor(Sensor.TYPE_GRAVITY)
    val accelerometer = manager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    return mapOf(
      "gyroscopeAvailable" to (gyro != null),
      "gyroscopeName" to gyro?.name,
      "gyroscopeVendor" to gyro?.vendor,
      "gyroscopeMinDelayUs" to gyro?.minDelay,
      "gyroscopeMaxRangeRadS" to gyro?.maximumRange?.toDouble(),
      "gyroscopeResolutionRadS" to gyro?.resolution?.toDouble(),
      "gravityAvailable" to (gravity != null),
      "accelerometerAvailable" to (accelerometer != null),
      "displayRotation" to readDisplayRotationDegrees(),
      "sdkInt" to Build.VERSION.SDK_INT,
      "manufacturer" to Build.MANUFACTURER,
      "model" to Build.MODEL
    )
  }

  @Suppress("DEPRECATION")
  private fun readDisplayRotationDegrees(): Int {
    val activity = appContext.currentActivity
    return when (activity?.windowManager?.defaultDisplay?.rotation ?: Surface.ROTATION_0) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }
  }

  private fun start(options: Map<String, Any?>): Map<String, Any?> {
    stop()
    val manager = sensorManager() ?: throw IllegalStateException("SensorManager is unavailable")
    val gyro = manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
      ?: throw IllegalStateException("This phone has no gyroscope")
    val upSensor = manager.getDefaultSensor(Sensor.TYPE_GRAVITY)
      ?: manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    val requestedPeriodUs = (options["samplingPeriodUs"] as? Number)?.toInt() ?: DEFAULT_SAMPLING_PERIOD_US
    val samplingPeriodUs = maxOf(MIN_SAMPLING_PERIOD_US, requestedPeriodUs)

    synchronized(lock) {
      clearBuffers()
      clearUp()
    }

    val listener = object : SensorEventListener {
      override fun onSensorChanged(event: SensorEvent) {
        val values = event.values
        if (values.size < 3) return
        synchronized(lock) {
          if (event.sensor.type == Sensor.TYPE_GYROSCOPE) {
            if (tMs.size >= MAX_BUFFERED_SAMPLES) {
              tMs.removeAt(0); gx.removeAt(0); gy.removeAt(0); gz.removeAt(0)
              droppedSamples += 1
            }
            tMs.add(event.timestamp / NANOS_PER_MS)
            gx.add(values[0].toDouble())
            gy.add(values[1].toDouble())
            gz.add(values[2].toDouble())
          } else {
            upSumX += values[0]
            upSumY += values[1]
            upSumZ += values[2]
            upCount += 1
          }
        }
      }

      override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit
    }

    val thread = HandlerThread("GyroYawRecorder").apply { start() }
    val handler = Handler(thread.looper)
    val gyroRegistered = manager.registerListener(listener, gyro, samplingPeriodUs, handler)
    if (!gyroRegistered) {
      thread.quitSafely()
      throw IllegalStateException("Could not register the gyroscope listener")
    }
    if (upSensor != null) manager.registerListener(listener, upSensor, SensorManager.SENSOR_DELAY_GAME, handler)
    recording = Recording(thread, listener)

    return mapOf(
      "samplingPeriodUs" to samplingPeriodUs,
      "gyroscopeName" to gyro.name,
      "upSensor" to when (upSensor?.type) {
        Sensor.TYPE_GRAVITY -> "gravity"
        Sensor.TYPE_ACCELEROMETER -> "accelerometer"
        else -> null
      },
      "upSensorName" to upSensor?.name,
      "displayRotation" to readDisplayRotationDegrees(),
      "startedAtMs" to SystemClock.elapsedRealtimeNanos() / NANOS_PER_MS
    )
  }

  /** Returns every gyroscope sample since the previous drain, plus the mean up vector over that span. */
  private fun drain(): Map<String, Any?> = synchronized(lock) {
    val result = mapOf(
      "tMs" to ArrayList(tMs),
      "x" to ArrayList(gx),
      "y" to ArrayList(gy),
      "z" to ArrayList(gz),
      "up" to if (upCount > 0) mapOf("x" to upSumX / upCount, "y" to upSumY / upCount, "z" to upSumZ / upCount) else null,
      "droppedSamples" to droppedSamples,
      "recording" to (recording != null)
    )
    clearBuffers()
    clearUp()
    result
  }

  private fun stop() {
    val current = recording ?: return
    recording = null
    sensorManager()?.unregisterListener(current.listener)
    current.thread.quitSafely()
  }

  private fun clearBuffers() {
    tMs.clear(); gx.clear(); gy.clear(); gz.clear()
    droppedSamples = 0
  }

  private fun clearUp() {
    upSumX = 0.0; upSumY = 0.0; upSumZ = 0.0; upCount = 0
  }
}

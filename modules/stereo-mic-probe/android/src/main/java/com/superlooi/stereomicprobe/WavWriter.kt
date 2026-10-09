package com.superlooi.stereomicprobe

import java.io.File
import java.io.RandomAccessFile

/**
 * Minimal PCM16 WAV writer for raw probe captures, so the stereo signal can be
 * analysed offline (pulled with adb from the app's external files directory).
 * The header is written with zero sizes and patched in [close].
 */
internal class WavWriter(val file: File, private val sampleRate: Int, private val channels: Int, private val maxFrames: Long) {
  private val output = RandomAccessFile(file, "rw")
  private var framesWritten = 0L
  private var closed = false

  init {
    output.setLength(0)
    output.write(ByteArray(HEADER_BYTES))
  }

  val isFull: Boolean get() = framesWritten >= maxFrames

  /** Appends whole interleaved frames from [pcm] until [maxFrames] is reached. */
  fun write(pcm: ShortArray, frames: Int) {
    if (closed || isFull) return
    val take = minOf(frames.toLong(), maxFrames - framesWritten).toInt()
    val bytes = ByteArray(take * channels * 2)
    for (index in 0 until take * channels) {
      val value = pcm[index].toInt()
      bytes[index * 2] = (value and 0xff).toByte()
      bytes[index * 2 + 1] = ((value shr 8) and 0xff).toByte()
    }
    output.write(bytes)
    framesWritten += take
  }

  fun close() {
    if (closed) return
    closed = true
    val dataBytes = framesWritten * channels * 2
    output.seek(0)
    output.writeBytes("RIFF")
    writeIntLe(36 + dataBytes)
    output.writeBytes("WAVEfmt ")
    writeIntLe(16)
    writeShortLe(1)
    writeShortLe(channels)
    writeIntLe(sampleRate.toLong())
    writeIntLe(sampleRate.toLong() * channels * 2)
    writeShortLe(channels * 2)
    writeShortLe(16)
    output.writeBytes("data")
    writeIntLe(dataBytes)
    output.close()
  }

  private fun writeIntLe(value: Long) {
    output.write(byteArrayOf(
      (value and 0xff).toByte(),
      ((value shr 8) and 0xff).toByte(),
      ((value shr 16) and 0xff).toByte(),
      ((value shr 24) and 0xff).toByte()
    ))
  }

  private fun writeShortLe(value: Int) {
    output.write(byteArrayOf((value and 0xff).toByte(), ((value shr 8) and 0xff).toByte()))
  }

  companion object {
    private const val HEADER_BYTES = 44
  }
}

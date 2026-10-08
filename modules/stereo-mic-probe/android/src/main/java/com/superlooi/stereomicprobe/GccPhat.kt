package com.superlooi.stereomicprobe

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * In-place iterative radix-2 complex FFT. [size] must be a power of two.
 * Twiddles and the bit-reversal permutation are precomputed once so the
 * capture thread never allocates while transforming.
 */
internal class ComplexFft(private val size: Int) {
  private val cosTable = DoubleArray(size / 2)
  private val sinTable = DoubleArray(size / 2)
  private val bitReversed = IntArray(size)

  init {
    require(size >= 2 && (size and (size - 1)) == 0) { "FFT size must be a power of two: $size" }
    for (index in 0 until size / 2) {
      val angle = -2.0 * PI * index / size
      cosTable[index] = cos(angle)
      sinTable[index] = sin(angle)
    }
    val bits = Integer.numberOfTrailingZeros(size)
    for (index in 0 until size) {
      bitReversed[index] = Integer.reverse(index) ushr (32 - bits)
    }
  }

  /** Forward transform uses e^(-j2πkn/N); the inverse is scaled by 1/N. */
  fun transform(re: DoubleArray, im: DoubleArray, inverse: Boolean) {
    for (index in 0 until size) {
      val other = bitReversed[index]
      if (other > index) {
        val tr = re[index]; re[index] = re[other]; re[other] = tr
        val ti = im[index]; im[index] = im[other]; im[other] = ti
      }
    }
    var length = 2
    while (length <= size) {
      val half = length / 2
      val step = size / length
      var start = 0
      while (start < size) {
        var twiddle = 0
        for (offset in 0 until half) {
          val wr = cosTable[twiddle]
          val wi = if (inverse) -sinTable[twiddle] else sinTable[twiddle]
          val a = start + offset
          val b = a + half
          val tr = re[b] * wr - im[b] * wi
          val ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
          twiddle += step
        }
        start += length
      }
      length = length shl 1
    }
    if (inverse) {
      val scale = 1.0 / size
      for (index in 0 until size) {
        re[index] *= scale
        im[index] *= scale
      }
    }
  }
}

/** Sub-sample delay between the two channels and a confidence measure. */
internal class GccPhatResult(
  /**
   * Delay of the LEFT channel relative to the RIGHT channel, in samples.
   * Positive means the left channel lags, i.e. sound reached the RIGHT channel first.
   */
  val tdoaSamples: Double,
  /** GCC peak divided by the mean absolute GCC over the searched lag window. */
  val peakRatio: Double
)

/**
 * GCC-PHAT time-difference-of-arrival estimator for one stereo window.
 *
 * The cross-spectrum X_L·conj(X_R) is normalised to unit magnitude (PHAT) and
 * inverse-transformed; the peak lag within +/- maxLag is refined with a
 * parabolic fit. Each channel has its mean removed and a Hann window applied
 * before zero-padding to [fftSize], which limits spectral leakage that PHAT
 * would otherwise amplify.
 */
internal class GccPhatEstimator(private val windowFrames: Int, private val fftSize: Int) {
  private val fft = ComplexFft(fftSize)
  private val hann = DoubleArray(windowFrames) { 0.5 - 0.5 * cos(2.0 * PI * it / (windowFrames - 1)) }
  private val leftRe = DoubleArray(fftSize)
  private val leftIm = DoubleArray(fftSize)
  private val rightRe = DoubleArray(fftSize)
  private val rightIm = DoubleArray(fftSize)

  fun estimate(left: DoubleArray, right: DoubleArray, requestedMaxLag: Int): GccPhatResult {
    val maxLag = requestedMaxLag.coerceIn(1, fftSize / 2 - 2)

    var leftMean = 0.0
    var rightMean = 0.0
    for (index in 0 until windowFrames) {
      leftMean += left[index]
      rightMean += right[index]
    }
    leftMean /= windowFrames
    rightMean /= windowFrames

    for (index in 0 until fftSize) {
      if (index < windowFrames) {
        leftRe[index] = (left[index] - leftMean) * hann[index]
        rightRe[index] = (right[index] - rightMean) * hann[index]
      } else {
        leftRe[index] = 0.0
        rightRe[index] = 0.0
      }
      leftIm[index] = 0.0
      rightIm[index] = 0.0
    }

    fft.transform(leftRe, leftIm, inverse = false)
    fft.transform(rightRe, rightIm, inverse = false)

    // Phase transform: X_L * conj(X_R) / (|X_L * conj(X_R)| + eps).
    for (bin in 0 until fftSize) {
      val re = leftRe[bin] * rightRe[bin] + leftIm[bin] * rightIm[bin]
      val im = leftIm[bin] * rightRe[bin] - leftRe[bin] * rightIm[bin]
      val magnitude = sqrt(re * re + im * im) + 1e-12
      leftRe[bin] = re / magnitude
      leftIm[bin] = im / magnitude
    }
    fft.transform(leftRe, leftIm, inverse = true)

    var bestLag = 0
    var bestValue = Double.NEGATIVE_INFINITY
    var absSum = 0.0
    for (lag in -maxLag..maxLag) {
      val value = leftRe[(lag + fftSize) % fftSize]
      absSum += abs(value)
      if (value > bestValue) {
        bestValue = value
        bestLag = lag
      }
    }
    val meanAbs = absSum / (2 * maxLag + 1)

    val before = leftRe[(bestLag - 1 + fftSize) % fftSize]
    val after = leftRe[(bestLag + 1 + fftSize) % fftSize]
    val denominator = before - 2.0 * bestValue + after
    val fraction = if (denominator < -1e-12) (0.5 * (before - after) / denominator).coerceIn(-0.5, 0.5) else 0.0

    val peakRatio = if (meanAbs > 1e-12 && bestValue > 0.0) bestValue / meanAbs else 0.0
    return GccPhatResult(bestLag + fraction, peakRatio)
  }
}

package com.superlooi.stereomicprobe

/** Outcome of one vote: the winning integer lag, how dominant it is, and how many windows took part. */
internal class LagVoteResult(
  /** Mode of the lag histogram over the voiced windows; null when no window was voiced. */
  val lagSamples: Int?,
  /** Fraction of the voiced windows whose lag is within +/- 1 sample of [lagSamples]; 0 when none. */
  val share: Double,
  /** Number of voiced windows counted. */
  val count: Int
)

/**
 * Rolling buffer of the most recent per-window peak lags with their voiced
 * flags. A single window's GCC-PHAT peak is unreliable, but over about a second
 * of voiced speech the lags cluster around the true delay, so the mode of the
 * histogram is a far steadier estimate than any one window or their median.
 *
 * Fixed-size and allocation-free after construction so the capture thread can
 * call it every hop.
 */
internal class LagVoteBuffer(private val capacity: Int, private val maxAbsLag: Int) {
  private val lags = IntArray(capacity)
  private val voiced = BooleanArray(capacity)
  private val histogram = IntArray(2 * maxAbsLag + 1)
  private var next = 0
  private var size = 0

  init {
    require(capacity >= 1 && maxAbsLag >= 1) { "Vote buffer needs a positive capacity and lag range" }
  }

  fun add(lag: Int, isVoiced: Boolean) {
    lags[next] = lag.coerceIn(-maxAbsLag, maxAbsLag)
    voiced[next] = isVoiced
    next = (next + 1) % capacity
    if (size < capacity) size++
  }

  /** Mode of the voiced lags. A tie goes to the lag whose latest occurrence is most recent. */
  fun tally(): LagVoteResult {
    var count = 0
    var topCount = 0
    for (age in 0 until size) {
      val index = (next - 1 - age + capacity) % capacity
      if (!voiced[index]) continue
      count++
      val bin = lags[index] + maxAbsLag
      histogram[bin]++
      if (histogram[bin] > topCount) topCount = histogram[bin]
    }
    if (count == 0) return LagVoteResult(null, 0.0, 0)

    // Newest first, so the first voiced window that reaches the top count is the most recent one.
    var mode = 0
    for (age in 0 until size) {
      val index = (next - 1 - age + capacity) % capacity
      if (voiced[index] && histogram[lags[index] + maxAbsLag] == topCount) {
        mode = lags[index]
        break
      }
    }
    var near = 0
    for (lag in (mode - 1)..(mode + 1)) {
      if (lag in -maxAbsLag..maxAbsLag) near += histogram[lag + maxAbsLag]
    }
    histogram.fill(0)
    return LagVoteResult(mode, near.toDouble() / count, count)
  }
}

// Trend awareness: knowing what is current, and knowing when you no longer know.
//
// A language model's training data has a date. Asked about something that changes, a model
// without retrieval answers from its own past with no way for the reader to see the date --
// which is how a model becomes confidently out of date. This module is the mechanism the
// Klyvaron family uses instead: observations with a date, a source and an expiry, and an
// abstention when nothing inside the requested window exists.
//
// THE RULES ARE THE POINT
//
//   1  NO SOURCE, NO OBSERVATION. `observe()` refuses a claim without an http(s) source URL.
//      An unsourced statement about what is current is a rumour, and a rumour does not become
//      a trend because it was stored.
//   2  NO DATE, NO OBSERVATION. The observation time is required and may not be in the future.
//      "Recently" is not a date.
//   3  EVERY OBSERVATION EXPIRES. Each carries a ttl in days. `current()` reports an entry
//      past its ttl as stale rather than current, so freshness is a property of the record and
//      not of how the answer was phrased.
//   4  IT ABSTAINS. `current()` with nothing inside the window returns an empty answer and
//      says why, naming the age of the newest entry it does hold. A caller cannot turn an
//      empty answer into an assertion without ignoring a field that says `abstained: true`.
//
// This is NOT the `trend.awareness` capability. That requires a model artifact and held-out
// scores (see tiers.mjs and docs/22). This module is the dated-source mechanism, it is
// tested here, and it claims nothing about any model.

export const DEFAULT_WINDOW_DAYS = 30

export class TrendError extends Error {
  constructor(message, code = 'trend_error') {
    super(message)
    this.name = 'TrendError'
    this.code = code
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
// Clock skew allowed on an observation's timestamp. A source cannot have observed the future.
const FUTURE_SKEW_MS = 5 * 60 * 1000

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

function sourceUrlOf(raw, where) {
  if (!isNonEmptyString(raw)) {
    throw new TrendError(`${where}: an observation needs a source URL. No source means the claim is a rumour.`, 'source_required')
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new TrendError(`${where}: source ${JSON.stringify(raw)} is not a URL.`, 'source_invalid')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TrendError(`${where}: source must be http(s), found ${parsed.protocol}`, 'source_scheme')
  }
  return parsed.toString()
}

export class TrendLedger {
  /**
   * @param {{ now?: () => number }} [options] `now` is injectable so that staleness is a
   *   property of the data and not of when a test happens to run.
   */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now
    this._entries = []
  }

  /**
   * Record one observation. Returns the stored entry, with the fields it was checked against.
   * Everything required is required: topic, claim, source, observation time, ttl and licence.
   */
  observe({ topic, claim, sourceUrl, observedAt, ttlDays = DEFAULT_WINDOW_DAYS, licence, sourceName = null }) {
    if (!isNonEmptyString(topic)) throw new TrendError('observe: topic is required', 'topic_required')
    if (!isNonEmptyString(claim)) throw new TrendError('observe: claim is required', 'claim_required')
    const source = sourceUrlOf(sourceUrl, 'observe')
    if (!isNonEmptyString(licence)) {
      throw new TrendError('observe: licence is required; an observation that may not be reused is not usable', 'licence_required')
    }
    const observed = new Date(observedAt)
    if (Number.isNaN(observed.getTime())) {
      throw new TrendError(`observe: observedAt ${JSON.stringify(observedAt)} is not a date`, 'observed_at_required')
    }
    if (observed.getTime() > this._now() + FUTURE_SKEW_MS) {
      throw new TrendError('observe: observedAt is in the future; an observation cannot predate its own timestamp', 'observed_at_future')
    }
    if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays <= 0) {
      throw new TrendError(`observe: ttlDays must be a positive number, found ${JSON.stringify(ttlDays)}`, 'ttl_invalid')
    }
    const entry = Object.freeze({
      topic: topic.trim(),
      claim: claim.trim(),
      sourceUrl: source,
      sourceName: sourceName ?? new URL(source).host,
      observedAt: observed.toISOString(),
      ttlDays,
      licence,
      recordedAt: new Date(this._now()).toISOString(),
    })
    this._entries.push(entry)
    return entry
  }

  /** Every observation held, newest first. `current()` is what decides what may be asserted. */
  entries() {
    return [...this._entries].sort((a, b) => b.observedAt.localeCompare(a.observedAt))
  }

  topics() {
    return [...new Set(this._entries.map((entry) => entry.topic))].sort()
  }

  /** Remove observations past their ttl. Returns the removed entries. */
  expire() {
    const now = this._now()
    const keep = []
    const removed = []
    for (const entry of this._entries) {
      const age = (now - new Date(entry.observedAt).getTime()) / DAY_MS
      ;(age > entry.ttlDays ? removed : keep).push(entry)
    }
    this._entries = keep
    return removed
  }

  /**
   * What may be said about a topic right now.
   *
   * Two windows apply and both must hold: the observation's own ttl, and the caller's
   * `maxAgeDays`. The return value always carries `abstained`, the `statement` to show, and
   * the stale entries it decided against, so a caller that answers anyway has to do it over a
   * field that says the ledger declined.
   */
  current({ topic, maxAgeDays = DEFAULT_WINDOW_DAYS } = {}) {
    if (!isNonEmptyString(topic)) throw new TrendError('current: topic is required', 'topic_required')
    if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      throw new TrendError(`current: maxAgeDays must be a positive number, found ${JSON.stringify(maxAgeDays)}`, 'window_invalid')
    }
    const now = this._now()
    const all = this.entries().filter((entry) => entry.topic === topic)
    const scored = all.map((entry) => {
      const ageDays = (now - new Date(entry.observedAt).getTime()) / DAY_MS
      return { ...entry, ageDays: Number(ageDays.toFixed(3)), fresh: ageDays <= entry.ttlDays && ageDays <= maxAgeDays }
    })
    const fresh = scored.filter((entry) => entry.fresh)
    const stale = scored.filter((entry) => !entry.fresh)
    const newest = scored[0] ?? null
    if (fresh.length > 0) {
      const head = fresh[0]
      return {
        topic,
        maxAgeDays,
        abstained: false,
        entries: fresh,
        stale,
        statement: `${fresh.length} current observation(s) on "${topic}"; the newest was observed `
          + `${head.observedAt} (${head.ageDays} day(s) ago) by ${head.sourceName} <${head.sourceUrl}>.`,
      }
    }
    return {
      topic,
      maxAgeDays,
      abstained: true,
      entries: [],
      stale,
      statement: newest === null
        ? `No observation on "${topic}" is held, so nothing is asserted. Checked at ${new Date(now).toISOString()}.`
        : `Nothing on "${topic}" is inside the ${maxAgeDays}-day window: the newest observation is `
          + `${newest.ageDays} day(s) old (${newest.observedAt}, ttl ${newest.ttlDays} day(s)), so nothing is asserted. `
          + 'Refreshing the source is what answers this, not a guess.',
    }
  }

  /** Serialisable form. Entries are plain data; the clock is not stored. */
  toJSON() {
    return { version: 1, entries: this._entries }
  }

  static fromJSON(data, { now = () => Date.now() } = {}) {
    const ledger = new TrendLedger({ now })
    for (const entry of data?.entries ?? []) {
      ledger.observe(entry)
    }
    return ledger
  }
}

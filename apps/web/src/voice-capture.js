export const VOICE_CAPTURE_LIMITS = Object.freeze({ sampleRate: 16_000, durationSeconds: 30, bytes: 2 * 1024 * 1024 })

/** Mix channels to mono and linearly resample without adding a runtime dependency. */
export function resampleMono(channels, sourceRate, targetRate = VOICE_CAPTURE_LIMITS.sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0 || !Number.isFinite(sourceRate) || sourceRate < 1 || !Number.isFinite(targetRate) || targetRate < 1) {
    throw Error('A valid audio buffer and sample rate are required.')
  }
  const length = Math.min(...channels.map((channel) => channel?.length ?? 0))
  if (!length) throw Error('The recording contains no audio samples.')
  const mono = new Float32Array(length)
  for (const channel of channels) {
    if (!channel || channel.length < length) throw Error('The recorded audio channels do not match.')
    for (let i = 0; i < length; i += 1) mono[i] += channel[i] / channels.length
  }
  if (sourceRate === targetRate) return mono
  const outLength = Math.max(1, Math.floor(length * targetRate / sourceRate))
  const output = new Float32Array(outLength)
  const ratio = sourceRate / targetRate
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, length - 1)
    const fraction = position - left
    output[i] = mono[left] * (1 - fraction) + mono[right] * fraction
  }
  return output
}

/** Encode normalized float samples as a standards-compliant mono PCM16 WAV. */
export function encodePcm16Wav(samples, sampleRate = VOICE_CAPTURE_LIMITS.sampleRate) {
  if (!(samples instanceof Float32Array) || samples.length === 0 || !Number.isInteger(sampleRate) || sampleRate < 1) {
    throw Error('Valid PCM samples and sample rate are required.')
  }
  const dataBytes = samples.length * 2
  if (dataBytes > VOICE_CAPTURE_LIMITS.bytes) throw Error('Recording is larger than the 2 MiB transcription limit.')
  const bytes = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(bytes)
  const ascii = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

/** Decode a browser recording container and convert it to the local voice model's 16 kHz WAV. */
export async function recordedBlobToWav(blob, AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext) {
  if (!blob || typeof blob.arrayBuffer !== 'function' || blob.size <= 0) throw Error('The microphone recording is empty.')
  if (blob.size > VOICE_CAPTURE_LIMITS.bytes) throw Error('Recording is larger than the 2 MiB transcription limit.')
  if (!AudioContextClass) throw Error('This browser cannot decode the recording format for local transcription.')
  const context = new AudioContextClass()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const duration = decoded.length / decoded.sampleRate
    if (duration > VOICE_CAPTURE_LIMITS.durationSeconds) throw Error('Recordings are limited to 30 seconds.')
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))
    return encodePcm16Wav(resampleMono(channels, decoded.sampleRate))
  } finally { await context.close?.() }
}

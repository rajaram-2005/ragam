import test from 'node:test'
import assert from 'node:assert/strict'
import { encodePcm16Wav, resampleMono, VOICE_CAPTURE_LIMITS } from '../src/voice-capture.js'

test('microphone channels are mixed to mono and resampled to 16 kHz', () => {
  const out = resampleMono([new Float32Array([0, 1, 0, -1]), new Float32Array([0, -1, 0, 1])], 48_000)
  assert.equal(out.length, 1)
  assert.equal(out[0], 0)
})

test('PCM16 WAV has correct RIFF, mono, sample-rate and data headers', async () => {
  const wav = encodePcm16Wav(new Float32Array([-1, 0, 1]))
  assert.equal(wav.type, 'audio/wav')
  const view = new DataView(await wav.arrayBuffer())
  assert.equal(new TextDecoder().decode(new Uint8Array(view.buffer, 0, 4)), 'RIFF')
  assert.equal(new TextDecoder().decode(new Uint8Array(view.buffer, 8, 4)), 'WAVE')
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), VOICE_CAPTURE_LIMITS.sampleRate)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 6)
  assert.equal(view.getInt16(44, true), -32768)
  assert.equal(view.getInt16(48, true), 32767)
})

test('invalid channel buffers and oversized recordings are refused', () => {
  assert.throws(() => resampleMono([], 48_000), /valid audio buffer/)
  assert.throws(() => encodePcm16Wav(new Float32Array(VOICE_CAPTURE_LIMITS.bytes)), /2 MiB/)
})

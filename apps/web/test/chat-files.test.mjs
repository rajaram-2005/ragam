import test from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_FILE_LIMITS, messageWithChatFiles, readChatAttachment, readChatTextFile, safeChatFileName } from '../src/chat-files.js'

const textFile = (name, text) => ({ name, size: Buffer.byteLength(text), text: async () => text })

test('plain text files are read locally and return only a safe name, byte size and text', async () => {
  const source = textFile('notes.md', '# Plan\nKeep this as a draft.')
  assert.deepEqual(await readChatTextFile(source), {
    name: 'notes.md', size: source.size, text: '# Plan\nKeep this as a draft.',
  })
})

test('unsupported, oversized and binary files are refused before they can enter a chat draft', async () => {
  await assert.rejects(readChatTextFile(textFile('photo.png', 'not an image')), /\.txt, \.md/)
  await assert.rejects(readChatTextFile({ name: 'oversized.txt', size: CHAT_FILE_LIMITS.textBytesEach + 1, text: async () => '' }), /200 KiB/)
  await assert.rejects(readChatTextFile(textFile('binary.json', '{\u0000}')), /plain UTF-8 text/)
  await assert.rejects(readChatTextFile(textFile('long.txt', 'x'.repeat(CHAT_FILE_LIMITS.charsTotal + 1))), /too large after text decoding/)
})

test('image bytes are validated and remain local until the caller builds the Send payload', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const file = { name: 'photo.png', size: png.length, arrayBuffer: async () => png.buffer }
  assert.deepEqual(await readChatAttachment(file), {
    name: 'photo.png', size: png.length, kind: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64'),
  })
  await assert.rejects(readChatAttachment({ ...file, name: 'fake.png', arrayBuffer: async () => new TextEncoder().encode('not a png').buffer }), /does not match/)
  assert.equal(messageWithChatFiles('', [{ name: 'photo.png', kind: 'image', data: 'never in this string' }]),
    'Attached image: photo.png (binary content is not retained in saved conversation history)')
})

test('PDF files are signature-checked and size-bounded before local extraction', async () => {
  const fake = new TextEncoder().encode('not a pdf')
  await assert.rejects(readChatAttachment({ name: 'x.pdf', size: fake.length, arrayBuffer: async () => fake.buffer }), /not a valid PDF/)
  await assert.rejects(readChatAttachment({ name: 'x.pdf', size: CHAT_FILE_LIMITS.bytesEach + 1, arrayBuffer: async () => new ArrayBuffer(0) }), /3 MiB/)
})

test('attachment text is included in the message only when the caller builds the Send payload', () => {
  assert.equal(messageWithChatFiles('  Explain this  '), 'Explain this')
  assert.equal(messageWithChatFiles('Summarize this', [{ name: 'notes.md', text: 'draft notes' }]),
    'Summarize this\n\nAttached file: notes.md (untrusted reference text)\n--- BEGIN FILE ---\ndraft notes\n--- END FILE ---')
})

test('file names lose control characters and are bounded', () => {
  assert.equal(safeChatFileName('  report\n Q1.csv  '), 'report Q1.csv')
  assert.equal(safeChatFileName('x'.repeat(300)).length, 160)
})

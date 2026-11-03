import { failure } from './failure.mjs'
import { redactSecrets } from '../policy/classify.mjs'

export const CHAT_CONTENT_LIMITS = Object.freeze({ messages: 100, textChars: 100_000, files: 3, bytesEach: 3 * 1024 * 1024, bytesTotal: 5 * 1024 * 1024 })
const MEDIA_MIMES = Object.freeze({
  image: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  audio: new Set(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/webm']),
  video: new Set(['video/mp4', 'video/webm']),
})

function safeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 160 && !/[\u0000-\u001f\u007f]/.test(name)
}
function bytesFromBase64(data, name) {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw failure('invalid_attachment', `${name} is not valid Base64 data.`, 400)
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw failure('invalid_attachment', `${name} is not canonical Base64 data.`, 400)
  if (bytes.length < 1 || bytes.length > CHAT_CONTENT_LIMITS.bytesEach) throw failure('invalid_attachment', `${name} exceeds the 3 MiB per-file Chat limit.`, 413)
  return bytes
}
function has(bytes, signature, offset = 0) { return signature.every((byte, index) => bytes[offset + index] === byte) }
function validSignature(type, mime, bytes) {
  if (mime === 'image/jpeg') return has(bytes, [0xff, 0xd8, 0xff])
  if (mime === 'image/png') return has(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  if (mime === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mime === 'audio/wav') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  if (mime === 'audio/flac') return bytes.subarray(0, 4).toString('ascii') === 'fLaC'
  if (mime === 'audio/ogg') return bytes.subarray(0, 4).toString('ascii') === 'OggS'
  if (mime === 'audio/mpeg') return bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  if (mime === 'audio/mp4' || mime === 'video/mp4') return bytes.subarray(4, 8).toString('ascii') === 'ftyp'
  if (mime === 'audio/webm' || mime === 'video/webm') return has(bytes, [0x1a, 0x45, 0xdf, 0xa3])
  return false
}
function placeholder(part) {
  return `[Attached ${part.type}: ${part.name}; binary media is not retained in saved conversation history]`
}
export function textFromChatContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => part.type === 'text' ? part.text : placeholder(part)).join('\n')
}

/** Validate the browser's last-turn content, separating provider payload from history-safe text. */
export function normalizeChatMessages(incoming) {
  if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > CHAT_CONTENT_LIMITS.messages) {
    throw failure('invalid_messages', 'Send between 1 and 100 user/assistant messages.')
  }
  const messages = []
  let mediaCount = 0
  let mediaBytes = 0
  const mediaKinds = new Set()
  for (let index = 0; index < incoming.length; index += 1) {
    const message = incoming[index]
    if (!message || !['user', 'assistant'].includes(message.role)) throw failure('invalid_messages', 'Chat messages can only contain user or assistant roles.')
    let content = message.content
    if (typeof content === 'string') {
      if (content.length > CHAT_CONTENT_LIMITS.textChars) throw failure('invalid_messages', 'A Chat message exceeds the 100,000-character limit.', 413)
    } else if (Array.isArray(content) && content.length > 0 && content.length <= CHAT_CONTENT_LIMITS.files + 1) {
      let textChars = 0
      content = content.map((part) => {
        if (part?.type === 'text' && typeof part.text === 'string') {
          textChars += part.text.length
          return { type: 'text', text: part.text }
        }
        if (!['image', 'audio', 'video'].includes(part?.type) || !safeName(part.name) || !MEDIA_MIMES[part.type]?.has(part.mimeType)) {
          throw failure('invalid_attachment', 'A Chat attachment has an unsupported type or invalid metadata.', 400)
        }
        const bytes = bytesFromBase64(part.data, part.name)
        if (!validSignature(part.type, part.mimeType, bytes)) throw failure('invalid_attachment', `${part.name} does not match its media type.`, 400)
        mediaCount += 1
        mediaBytes += bytes.length
        mediaKinds.add(part.type)
        return { type: part.type, name: part.name, mimeType: part.mimeType, data: part.data }
      })
      if (textChars > CHAT_CONTENT_LIMITS.textChars) throw failure('invalid_messages', 'A Chat message exceeds the 100,000-character limit.', 413)
    } else throw failure('invalid_messages', 'Message content must be text or a bounded list of supported media parts.')
    messages.push({ role: message.role, content })
  }
  if (messages.at(-1).role !== 'user') throw failure('invalid_messages', 'The last message must be from the user.')
  if (mediaCount > CHAT_CONTENT_LIMITS.files || mediaBytes > CHAT_CONTENT_LIMITS.bytesTotal) {
    throw failure('invalid_attachment', 'Chat accepts at most three media files and 5 MiB total media per turn.', 413)
  }
  if (mediaCount && messages.slice(0, -1).some((message) => Array.isArray(message.content))) {
    throw failure('invalid_attachment', 'Media can only be included in the current user message, not replayed from history.', 400)
  }
  const prompt = textFromChatContent(messages.at(-1).content)
  if (!prompt.trim()) throw failure('invalid_messages', 'The last user message must include text or an attachment.')
  return { messages, prompt, mediaKinds: [...mediaKinds], mediaCount, mediaBytes }
}

/** Redact ordinary prompt text, but preserve validated media bytes byte-for-byte. */
export function redactChatMessages(messages) {
  const findings = new Set()
  const redact = (value) => {
    const result = redactSecrets(value)
    result.findings.forEach((finding) => findings.add(finding))
    return result.text
  }
  const value = messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string'
      ? redact(message.content)
      : message.content.map((part) => part.type === 'text' ? { ...part, text: redact(part.text) } : part),
  }))
  return { value, findings: [...findings] }
}

const CHAT_TEXT_FILE_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log'])
const IMAGE_TYPES = Object.freeze({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })
const AUDIO_TYPES = Object.freeze({ '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm' })
const VIDEO_TYPES = Object.freeze({ '.mp4': 'video/mp4', '.webm': 'video/webm' })
export const CHAT_FILE_LIMITS = Object.freeze({ files: 3, bytesEach: 3 * 1024 * 1024, textBytesEach: 200 * 1024, charsTotal: 80_000, mediaBytesTotal: 5 * 1024 * 1024 })

function extensionOf(name) {
  const point = String(name ?? '').lastIndexOf('.')
  return point < 0 ? '' : String(name).slice(point).toLowerCase()
}

export function safeChatFileName(name) {
  const safe = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  return safe || 'attached-text'
}

/** Read a small text document in the browser; this function never uploads it. */
export async function readChatTextFile(file) {
  if (!file || typeof file.text !== 'function') throw Error('Choose a readable text file.')
  const name = safeChatFileName(file.name)
  if (!CHAT_TEXT_FILE_EXTENSIONS.has(extensionOf(name))) {
    throw Error('Chat attachments currently accept .txt, .md, .csv, .json and .log files only.')
  }
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > CHAT_FILE_LIMITS.textBytesEach) {
    throw Error('Each attached text file must be 200 KiB or smaller.')
  }
  const text = await file.text()
  if (typeof text !== 'string' || text.includes('\u0000')) throw Error(`${name} does not appear to be plain UTF-8 text.`)
  if (text.length > CHAT_FILE_LIMITS.charsTotal) throw Error(`${name} is too large after text decoding.`)
  return { name, size: file.size, text }
}

function base64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function hasSignature(bytes, signature, offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value)
}

function validMediaSignature(extension, bytes) {
  if (extension === '.jpg' || extension === '.jpeg') return hasSignature(bytes, [0xff, 0xd8, 0xff])
  if (extension === '.png') return hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (extension === '.gif') return ['GIF87a', 'GIF89a'].some((magic) => new TextDecoder().decode(bytes.subarray(0, 6)) === magic)
  if (extension === '.webp') return new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  if (extension === '.wav') return new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WAVE'
  if (extension === '.flac') return new TextDecoder().decode(bytes.subarray(0, 4)) === 'fLaC'
  if (extension === '.ogg') return new TextDecoder().decode(bytes.subarray(0, 4)) === 'OggS'
  if (extension === '.mp3') return new TextDecoder().decode(bytes.subarray(0, 3)) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  if (extension === '.m4a' || extension === '.mp4') return new TextDecoder().decode(bytes.subarray(4, 8)) === 'ftyp'
  if (extension === '.webm') return hasSignature(bytes, [0x1a, 0x45, 0xdf, 0xa3])
  return false
}

async function extractPdfText(bytes, { maxPages = 40, maxChars = CHAT_FILE_LIMITS.charsTotal } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWorkerFetch: false, stopAtErrors: true })
  const document = await task.promise
  try {
    if (document.numPages > maxPages) throw Error(`PDFs are limited to ${maxPages} pages.`)
    const pages = []
    let total = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.filter((item) => typeof item.str === 'string').map((item) => item.str).join(' ')
      total += text.length
      if (total > maxChars) throw Error(`Extracted PDF text exceeds ${maxChars.toLocaleString()} characters.`)
      pages.push(`Page ${pageNumber}: ${text}`)
      page.cleanup()
    }
    const text = pages.join('\n\n')
    if (!text.trim()) throw Error('No selectable text was found in this PDF; scanned-image OCR is not available in Chat yet.')
    return text
  } finally { await task.destroy() }
}

/** Read supported attachments locally; binary media is only returned to Core when Send is pressed. */
export async function readChatAttachment(file) {
  const extension = extensionOf(safeChatFileName(file?.name))
  if (CHAT_TEXT_FILE_EXTENSIONS.has(extension)) return { ...(await readChatTextFile(file)), kind: 'text' }
  if (!file || typeof file.arrayBuffer !== 'function') throw Error('Choose a readable file.')
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > CHAT_FILE_LIMITS.bytesEach) throw Error('Each PDF or media file must be 3 MiB or smaller.')
  const name = safeChatFileName(file.name)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (extension === '.pdf') {
    if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw Error(`${name} is not a valid PDF file.`)
    return { name, size: file.size, kind: 'pdf', text: await extractPdfText(bytes) }
  }
  const imageType = IMAGE_TYPES[extension]
  const audioType = AUDIO_TYPES[extension]
  const videoType = VIDEO_TYPES[extension]
  const mimeType = imageType ?? audioType ?? videoType
  if (!mimeType) throw Error('Chat supports small text files, text-based PDFs, images, audio and video files.')
  if (!validMediaSignature(extension, bytes)) throw Error(`${name} does not match its declared file type.`)
  return { name, size: file.size, kind: imageType ? 'image' : audioType ? 'audio' : 'video', mimeType, data: base64(bytes) }
}

/** Compose attachment descriptions into the transcript; actual media bytes stay out of saved history. */
export function messageWithChatFiles(message, attachments = []) {
  const question = String(message ?? '').trim()
  if (!attachments.length) return question
  const sources = attachments.map(({ name, kind, text }) => {
    const safeName = safeChatFileName(name)
    if (kind === 'image' || kind === 'audio' || kind === 'video') return `Attached ${kind}: ${safeName} (binary content is not retained in saved conversation history)`
    return `Attached file: ${safeName} (untrusted reference text)\n--- BEGIN FILE ---\n${String(text ?? '')}\n--- END FILE ---`
  })
  return [question, ...sources].filter(Boolean).join('\n\n')
}

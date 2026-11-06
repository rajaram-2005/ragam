// Regenerate tests/fixtures/text-parity.json from the Node implementation.
//
// The Python port in fabric/text.py and fabric/bm25.py is compared against this
// fixture by tests/test_parity.py. Regenerating requires Node; the fixture is
// committed so the Python suite stays runnable without it.
//
//   node scripts/generate-parity-fixture.mjs > tests/fixtures/text-parity.json
import { tokenize, contentTokens, stemTokens, stem, chunkText, splitSentences } from '../../core/src/knowledge/text.mjs'
import { Bm25Index } from '../../core/src/knowledge/bm25.mjs'

const TEXTS = [
  '',
  'Hello world',
  'The pack contactor must open within 250 milliseconds when any cell exceeds 68 degrees Celsius.',
  "It's a test of the tokenizer's handling of apostrophes, hyphens and 42 numbers.",
  'CONTACTORS opening cleanly; isolation resistance stays above 500 ohms per volt at all times.',
  'x'.repeat(4500),
  Array.from({ length: 60 }, (_, i) => `Sentence ${i} describes the contactor and thermal limits in detail.`).join(' '),
  'Multiple\n\nparagraphs. With! Newlines? And   collapsed    spacing.',
  'a i 7 5G running studies boxes churches status analysis',
  'The project codename is ZEPHYR-9 and the model id is klyvaron-pro-lm version 0-1-0.',
]

const QUERIES = [
  'contactor opening threshold',
  'isolation resistance ohms per volt',
  'the and of',
  'thermal limits',
  'nothing matches this at all',
  'ZEPHYR codename',
  'klyvaron pro model',
]

const index = new Bm25Index()
TEXTS.forEach((text, i) => index.add(`doc-${String(i).padStart(2, '0')}`, text, { index: i }))

const fixture = {
  generatedBy: 'services/fabric/scripts/generate-parity-fixture.mjs',
  source: 'services/core/src/knowledge/{text,bm25}.mjs',
  texts: TEXTS,
  queries: QUERIES,
  tokenize: TEXTS.map((t) => tokenize(t)),
  contentTokens: TEXTS.map((t) => contentTokens(t)),
  stemTokens: TEXTS.map((t) => stemTokens(t)),
  stem: ['running', 'studies', 'boxes', 'churches', 'status', 'analysis', 'openness', 'ational', 'ies', 'ss', 'us', 'es', 'ing', 'edly', 'ied', 'a', 'the'].map((w) => [w, stem(w)]),
  splitSentences: TEXTS.map((t) => splitSentences(t)),
  chunkText: TEXTS.map((t) => chunkText(t)),
  bm25: {
    k1: index.k1,
    b: index.b,
    stats: index.stats(),
    searches: QUERIES.map((q) => ({ query: q, topK: 5, hits: index.search(q, { topK: 5 }) })),
  },
}
process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`)

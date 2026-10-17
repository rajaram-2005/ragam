// The packs that ship with this build.
//
// Three, deliberately, and each is small enough to read in a minute. A pack is a claim about how a
// field works, so shipping thirty of them would be shipping thirty unverified claims; these three
// are the ones whose content is checkable against the repository itself.
//
// Each declares what it refuses as well as what it offers, and the two regulated ones require
// human review — not as boilerplate, but because the pack's own vocabulary is what a person would
// act on, and no test in this repository can verify a legal opinion.

const CHECKED_AT = Date.UTC(2026, 9, 17)

export const BUILTIN_PACKS = Object.freeze([
  Object.freeze({
    id: 'engineering.repo-maintenance',
    name: 'Repository maintenance',
    industry: 'engineering',
    version: '1.0.0',
    description: 'Vocabulary, refusals and review rules for keeping a source tree tidy: measures before changes, reverts whole, and never deletes what it did not create without a second look.',
    restrictions: {
      dataClassFloor: 'internal',
      refusedActions: ['fs.delete', 'network.external'],
      requireHumanReview: true,
      requireSources: false,
    },
    refuses: [
      'It will not delete a file it did not create in this session without a named reviewer.',
      'It will not run a command whose effect it cannot measure first.',
      'It will not report a cleanup as complete because the command exited zero.',
    ],
    capabilities: [
      { tag: 'tree.line-count', evidence: 'services/core/test/adaptive-loop.test.mjs', purpose: 'measure a tree before proposing a change' },
      { tag: 'chat.completion', unimplemented: true, purpose: 'explain a proposed change in prose' },
    ],
    vocabulary: {
      'working tree': 'The files as they are on disk, including uncommitted changes.',
      'clean': 'No untracked or modified files that the repository tracks. Not the same as "correct".',
      'revert': 'Restore a file to its committed content; it is not the same as deleting the change\'s intent.',
    },
    disclaimers: [
      'A cleanup that reports success has been measured, not trusted; if no measurement is shown, treat it as unverified.',
    ],
    sources: [],
    provenance: { author: 'aetheris', created: Date.UTC(2026, 9, 17), licence: 'MIT' },
  }),

  Object.freeze({
    id: 'legal.document-review',
    name: 'Contract review support',
    industry: 'legal',
    version: '1.0.0',
    description: 'Reading support for contract review: defines the terms reviewers ask about, refuses to advise, and requires that a qualified person reads every answer before it is relied on.',
    restrictions: {
      dataClassFloor: 'confidential',
      refusedActions: ['fs.write', 'fs.delete', 'network.external', 'media.generate'],
      requireHumanReview: true,
      // False because this pack contains definitions and refusals, not claims about law. The rule
      // that legal *answers* need a cited source lives in `refuses`, below, and is enforced at
      // answer time -- whereas setting this flag with no sources would be refused at install,
      // correctly, and citing a source nobody verified would be worse.
      requireSources: false,
    },
    refuses: [
      'It will not give legal advice, and it will not say whether an agreement is enforceable.',
      'It will not state the law of a jurisdiction from memory; a statement about law needs a cited, licensed source.',
      'It will not sign, send or file anything.',
    ],
    capabilities: [
      { tag: 'repo.read', unimplemented: true, purpose: 'read a document the user has opened' },
      { tag: 'chat.completion', unimplemented: true, purpose: 'summarise a clause in plain words' },
    ],
    vocabulary: {
      'indemnity': 'A promise to cover another party\'s loss; its scope is set by the clause, not by the word.',
      'force majeure': 'A clause allocating the risk of events outside a party\'s control; what it covers varies by drafting and jurisdiction.',
      'governing law': 'The jurisdiction whose courts and statutes interpret the agreement.',
    },
    disclaimers: [
      'This is reading support, not legal advice. A qualified lawyer must review every answer before it is relied on.',
      'No statement about enforceability or about the law of any jurisdiction is made without a cited source.',
    ],
    sources: [],
    provenance: { author: 'aetheris', created: Date.UTC(2026, 9, 17), licence: 'MIT' },
  }),

  Object.freeze({
    id: 'education.grounded-tutoring',
    name: 'Grounded tutoring',
    industry: 'education',
    version: '1.0.0',
    description: 'Tutoring rules that keep explanations tied to a source the learner can open, mark uncertainty instead of smoothing it, and never present a guess as a fact.',
    restrictions: {
      dataClassFloor: 'internal',
      refusedActions: ['network.external', 'media.generate'],
      requireHumanReview: false,
      requireSources: false,
    },
    refuses: [
      'It will not answer a question about a textbook it has not been given.',
      'It will not mark its own explanation as correct; a check is done by recomputation or a second source.',
      'It will not guess a learner\'s age, ability or background from how they write.',
    ],
    capabilities: [
      { tag: 'chat.completion', unimplemented: true, purpose: 'explain in prose' },
    ],
    vocabulary: {
      'worked example': 'A problem solved step by step, where each step states what it used.',
      'source': 'A document the learner can open; an explanation without one is an opinion.',
    },
    disclaimers: [
      'An explanation is not a verification; where a claim is checked, the check is named.',
    ],
    sources: [],
    provenance: { author: 'aetheris', created: Date.UTC(2026, 9, 17), licence: 'MIT' },
  }),
])

/** Install every built-in pack, returning what was installed and any that failed validation. */
export function installBuiltinPacks(registry) {
  const installed = []
  const failed = []
  for (const pack of BUILTIN_PACKS) {
    try {
      installed.push(registry.install(pack))
    } catch (error) {
      failed.push({ id: pack.id, code: error.code ?? 'pack_invalid', problems: error.problems ?? [] })
    }
  }
  return Object.freeze({ installed: Object.freeze(installed), failed: Object.freeze(failed) })
}

export const BUILTIN_PACK_IDS = Object.freeze(BUILTIN_PACKS.map((pack) => pack.id))

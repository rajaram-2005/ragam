// SKILL.md parsing and validation.
//
// Directive §6B (procedural memory and reusable skills): skills store "successful
// procedures, not just factual summaries", carrying "the verified steps,
// prerequisites, inputs, outputs, tools, expected results and known failure cases".
// Directive §6B also says to "follow compatible open skill-format conventions where
// appropriate, after checking current specifications and licences".
//
// WHAT WAS CHECKED, AND WHAT COULD NOT BE
//
// The format below follows the `SKILL.md` convention as observed in Hermes Agent
// (MIT) -- a YAML frontmatter block followed by a fixed section order -- because that
// repository is reachable and its own AGENTS.md documents the format and states
// agentskills.io compatibility. The agentskills.io specification itself is NOT
// reachable from this host, so this is a compatible SUBSET as observed, not a
// verified implementation of the published standard. That distinction matters and is
// recorded in docs/10-hermes-audit.md §5 rather than glossed.
//
// Two rules are adopted verbatim from Hermes's authoring standard because they are
// good engineering rather than style preferences:
//
//   1. `description` is capped at 60 characters, one sentence. Hermes's stated reason
//      is that long descriptions "bloat listings and dilute attention when many skills
//      load" -- which is the progressive-disclosure problem stated precisely.
//   2. `platforms` must be declared when a procedure depends on a POSIX-only
//      primitive. A skill that silently assumes Linux is a skill that fails on a
//      phone, and phones are the point of Klyvaron Lite.

export const MAX_DESCRIPTION_CHARS = 60

/** Sections a skill must contain. These are what make it a procedure. */
export const REQUIRED_SECTIONS = Object.freeze(['When to Use', 'Procedure', 'Verification'])

/** Sections Hermes lists in its modern order; expected but not all mandatory. */
export const RECOMMENDED_SECTIONS = Object.freeze([
  'Prerequisites', 'How to Run', 'Quick Reference', 'Pitfalls',
])

/**
 * Provenance, and the reason it is a required field rather than metadata.
 *
 * Directive §6C forbids an agent from silently rewriting system instructions or
 * installing arbitrary code because it believes it learned something. The lifecycle
 * enforces that structurally: only `agent`-created skills are eligible for automatic
 * transitions, `human` and `bundled` skills are never touched by the curator. A skill
 * without provenance therefore cannot be curated safely, so it is rejected.
 */
export const CREATED_BY = Object.freeze(['agent', 'human', 'bundled'])

/** Marketing words Hermes bans from descriptions; they convey nothing. */
const MARKETING_WORDS = ['powerful', 'comprehensive', 'seamless', 'advanced', 'robust', 'cutting-edge', 'state-of-the-art']

/**
 * POSIX-only primitives that require an explicit `platforms` declaration.
 * Adopted from Hermes's platform audit, narrowed to what is checkable statically here.
 */
const PLATFORM_BOUND = [
  ['/(^|[^\\w])/proc/`?', '/proc'],
  ['\\bapt-get\\b|\\bapt install\\b', 'apt'],
  ['\\bsystemctl\\b', 'systemctl'],
  ['\\bosascript\\b', 'osascript'],
  ['\\bfcntl\\b', 'fcntl'],
  ['\\btermios\\b', 'termios'],
  ['\\bsetsid\\b', 'setsid'],
  ['\\bsignal\\.SIGKILL\\b', 'signal.SIGKILL'],
  ['(^|[^\\w.])\\/tmp\\/', 'a hardcoded /tmp path'],
]

export class SkillDocumentError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'SkillDocumentError'
    this.code = 'invalid_skill_document'
    this.errors = errors
  }
}

/**
 * Parse the YAML frontmatter subset that SKILL.md uses.
 *
 * Deliberately not a YAML implementation: the subset is maps, inline lists, quoted and
 * bare scalars, and one level of nesting (`metadata: \n  hermes:\n    tags: [...]`).
 * A general YAML parser would be a dependency and a parser-differential risk for a
 * file format this small and this constrained. Anything outside the subset is
 * reported as an error rather than guessed at.
 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { frontmatter: null, body: text, errors: ['document does not start with a YAML frontmatter block'] }

  const frontmatter = {}
  const errors = []
  // Containers are tracked by indentation, not by "the most recent key". The previous version
  // descended into the last key each time the indent increased *without ever coming back up*,
  // so a nested block with two sibling keys sent the second one into the first one's value:
  //
  //   permissions:
  //     fsRead: [/tmp/a]
  //     fsWrite: [/tmp/b]     <- landed inside fsRead's list
  //
  // Every nested block in the repository had exactly one child, so the bug was invisible until
  // a frontmatter block declared more than one thing. Found by the Phase 4 permission tests.
  const stack = [{ container: frontmatter, indent: -1 }]
  // A key whose value is written as a block sequence. Set when a line ends in ':' with
  // nothing after it, and used by the '- item' lines that follow.
  let pendingList = null

  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()


    // A YAML block sequence, which is how hand-written skill documents usually write a
    // list:
    //
    //   tags:
    //     - docker
    //     - build
    //
    // The parser claims to read a subset of YAML, and a list on its own line is part of
    // the subset every real SKILL.md file uses. Refusing it would have made the format
    // "compatible" only with documents this repository wrote itself.
    if (line.startsWith('- ') || line === '-') {
      const item = unquote(line.slice(1).trim())
      if (!pendingList || indent <= pendingList.indent) {
        errors.push(`list item has no key to belong to: '${line}'`)
        continue
      }
      if (/^[A-Za-z_][A-Za-z0-9_-]*:\s/.test(item)) {
        // Silently storing 'name: value' as a string would look parsed when it is not.
        errors.push(`lists of mappings are not supported by this parser: '${line}'`)
        continue
      }
      const { container, key } = pendingList
      if (!Array.isArray(container[key])) container[key] = []
      container[key].push(item)
      continue
    }

    const colon = line.indexOf(':')
    if (colon === -1) { errors.push(`frontmatter line is not a key/value pair: '${line}'`); continue }
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()

    // Come back up to the block this line belongs to. A line at the same indent as the previous
    // key is a sibling; only a deeper indent is a child.
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop()
    const current = stack.at(-1).container

    if (value === '') {
      // A map or a block sequence begins here; which one it is, is decided by the next line,
      // which either names a key (map) or starts with '- ' (list).
      current[key] = {}
      stack.push({ container: current[key], indent })
      pendingList = { container: current, key, indent }
      continue
    }
    pendingList = null

    if (value.startsWith('[') && value.endsWith(']')) {
      current[key] = value.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean)
    } else if (value === 'true' || value === 'false') {
      current[key] = value === 'true'
    } else if (/^-?\d+$/.test(value)) {
      current[key] = Number(value)
    } else {
      current[key] = unquote(value)
    }
  }

  return { frontmatter, body: text.slice(match[0].length), errors }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/** Split a markdown body into `## Heading -> text` sections, in document order. */
export function parseSections(body) {
  const sections = new Map()
  const order = []
  let current = null
  let buffer = []
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) sections.set(current, buffer.join('\n').trim())
      current = heading[1]
      order.push(current)
      buffer = []
    } else if (current) {
      buffer.push(line)
    }
  }
  if (current) sections.set(current, buffer.join('\n').trim())
  return { sections, order }
}

/** Count numbered procedure steps: `1.` / `1)` at the start of a line. */
export function countProcedureSteps(procedure) {
  return (procedure ?? '').split(/\r?\n/).filter((line) => /^\s*\d+[.)]\s+\S/.test(line)).length
}

/**
 * Validate a parsed skill document.
 *
 * Returns a report rather than throwing, because the caller (the registry) needs to
 * record *why* a skill was rejected; a thrown message loses that structure.
 */
export function validateSkillDocument(input, { directoryName = null, requireSections = REQUIRED_SECTIONS } = {}) {
  const errors = []
  const warnings = []

  const text = typeof input === 'string' ? input : input?.text ?? ''
  const { frontmatter, body, errors: parseErrors } = parseFrontmatter(text)
  errors.push(...parseErrors)

  if (!frontmatter) return { valid: false, errors, warnings, frontmatter: null, sections: null }

  // --- required identity fields -------------------------------------------------
  for (const field of ['name', 'description', 'version', 'license', 'createdBy']) {
    if (!frontmatter[field]) errors.push(`missing required field '${field}'`)
  }
  if (!frontmatter.author) warnings.push("no 'author' field; credit the human who wrote the procedure")

  const name = String(frontmatter.name ?? '')
  if (name && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
    errors.push(`name '${name}' must be lowercase kebab-case, 2-63 characters`)
  }
  if (directoryName && name && directoryName !== name) {
    errors.push(`name '${name}' does not match its directory '${directoryName}'`)
  }

  const description = String(frontmatter.description ?? '')
  if (description) {
    if (description.length > MAX_DESCRIPTION_CHARS) {
      errors.push(
        `description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}. ` +
        'Long descriptions bloat listings and dilute attention when many skills load.',
      )
    }
    if (!description.endsWith('.')) errors.push('description must end with a period')
    if (description.split(/[.!?]/).filter((s) => s.trim()).length > 1) {
      errors.push('description must be a single sentence')
    }
    for (const word of MARKETING_WORDS) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(description)) {
        errors.push(`description contains the marketing word '${word}'; state the capability instead`)
      }
    }
    if (name && description.toLowerCase().includes(name.replace(/-/g, ' ').toLowerCase())) {
      errors.push('description repeats the skill name; say what it does, not what it is called')
    }
  }

  if (frontmatter.version && !/^\d+\.\d+\.\d+$/.test(String(frontmatter.version))) {
    errors.push(`version '${frontmatter.version}' is not major.minor.patch`)
  }

  if (frontmatter.createdBy && !CREATED_BY.includes(frontmatter.createdBy)) {
    errors.push(`createdBy must be one of ${CREATED_BY.join(', ')}; found '${frontmatter.createdBy}'`)
  }

  // A document with no `permissions:` block declares nothing: no reads, no writes, no network.
  // That is the safe default, and it still has to be visible, because a procedure that reads
  // a tree and never said so will fail the moment it is run rather than at review time.
  if (frontmatter.permissions === undefined) {
    warnings.push("no 'permissions' block; the procedure declares no filesystem or network access")
  }

  // --- sections ----------------------------------------------------------------
  const { sections, order } = parseSections(body)
  for (const section of requireSections) {
    if (!sections.has(section)) errors.push(`missing required section '## ${section}'`)
  }
  for (const section of RECOMMENDED_SECTIONS) {
    if (!sections.has(section)) warnings.push(`no '## ${section}' section`)
  }

  const steps = countProcedureSteps(sections.get('Procedure'))
  if (sections.has('Procedure') && steps < 1) {
    errors.push("the '## Procedure' section must contain at least one numbered step; a procedure with no steps is a note")
  }

  // --- platform gating ----------------------------------------------------------
  // A procedure that silently assumes Linux fails on a phone, and phones are the
  // point of Klyvaron Lite. Declaring `platforms` is what makes the assumption
  // visible to the loader instead of surfacing as a runtime failure for the user.
  const declaredPlatforms = Array.isArray(frontmatter.platforms) ? frontmatter.platforms
    : frontmatter.platforms ? [frontmatter.platforms] : []
  if (!declaredPlatforms.length) {
    for (const [pattern, label] of PLATFORM_BOUND) {
      if (new RegExp(pattern).test(text)) {
        errors.push(
          `the procedure depends on ${label}, so it must declare a 'platforms' list. ` +
          'Prefer a portable primitive (tempfile, pathlib) before narrowing the platform.',
        )
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    frontmatter,
    sections,
    sectionOrder: order,
    procedureSteps: steps,
  }
}

/** Convenience: parse and validate in one call, for the loader and the tests. */
export function loadSkillDocument(text, options = {}) {
  const report = validateSkillDocument(text, options)
  if (!report.valid) {
    throw new SkillDocumentError(
      `skill document failed validation: ${report.errors.join('; ')}`,
      report.errors,
    )
  }
  return report
}

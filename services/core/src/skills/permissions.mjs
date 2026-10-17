// What a stored procedure is allowed to touch, and who gets to decide.
//
// Directive §6B: a skill is an executable artifact with "defined inputs, outputs,
// permissions, dependencies, tests and limitations" -- permissions are part of the artifact,
// not a property of whoever happens to run it. Directive §6C: "Do not silently rewrite core
// system instructions, **grant new permissions** or install arbitrary code because an agent
// believes it has learned something."
//
// Two failures this module exists to make impossible:
//
//   1. **A declaration nothing reads.** If the `permissions:` block in a SKILL.md is
//      decoration, then the document says one thing and the running code does another, and
//      the document is the thing a human reviews.
//   2. **A runtime that decides the scope.** If the wrapper chooses the permission, then a
//      procedure written to read one directory can be handed the whole filesystem by whoever
//      wraps it -- including the agent that proposed it. The scope must come from the stored
//      document, because the document is what was approved.
//
// So the rule is one-directional and it refuses rather than adjusts:
//
//   * declared ⊄ granted -> refuse (`permission_widening`), naming the root the runtime does
//     not allow. Silently narrowing would run the procedure with less than it declared and
//     fail somewhere inside it, which is the worst of both: the human sees a procedure
//     failure rather than a permissions disagreement.
//   * granted ⊄ declared -> the excess is simply never passed on. The procedure gets exactly
//     what its own document asked for, no matter how generous the caller was feeling.
//
// And one rule that is about the *learner* rather than the document: a skill the system wrote
// itself may not propose reading `/`, reading the user's home directory, or reaching the
// network. A human can write that down; an agent inferring it from a successful task cannot.

import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'

import { parseFrontmatter } from './manifest.mjs'

export const PERMISSION_KEYS = Object.freeze(['fsRead', 'fsWrite', 'network'])

/** The declaration of a document that declares nothing: no reads, no writes, no network. */
export const NO_PERMISSIONS = Object.freeze({
  fsRead: Object.freeze([]),
  fsWrite: Object.freeze([]),
  network: false,
})

export class SkillPermissionError extends Error {
  constructor(message, code = 'skill_permission_error', detail = {}) {
    super(message)
    this.name = 'SkillPermissionError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Read the `permissions:` block out of parsed frontmatter.
 *
 * An unknown key is refused rather than ignored. `internet: true` and `fsread: [...]` both
 * look to a human like a constraint is being stated, and a parser that ignores them produces
 * a document that claims a restriction it does not have.
 */
export function declarationFrom(frontmatter, { source = 'the document' } = {}) {
  const raw = frontmatter?.permissions
  if (raw === undefined || raw === null) return NO_PERMISSIONS
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillPermissionError(
      `${source} has a 'permissions' block that is ${Array.isArray(raw) ? 'a list' : `a ${typeof raw}`}; ` +
        'expected a mapping of fsRead, fsWrite and network',
      'invalid_permissions_block',
      { found: raw },
    )
  }
  for (const key of Object.keys(raw)) {
    if (!PERMISSION_KEYS.includes(key)) {
      throw new SkillPermissionError(
        `${source} declares an unknown permission '${key}'; only ${PERMISSION_KEYS.join(', ')} are ` +
          'understood, and an unknown one would be a restriction nobody enforces',
        'unknown_permission_key',
        { key },
      )
    }
  }
  return Object.freeze({
    ...normaliseRoots(raw.fsRead, 'fsRead', source),
    ...normaliseRoots(raw.fsWrite, 'fsWrite', source),
    network: normaliseNetwork(raw.network, source),
  })
}

function normaliseRoots(value, key, source) {
  if (value === undefined || value === null) return { [key]: Object.freeze([]) }
  const list = Array.isArray(value) ? value : [value]
  const roots = []
  for (const item of list) {
    const text = String(item ?? '').trim()
    if (!text) {
      throw new SkillPermissionError(
        `${source} has an empty entry in '${key}'; an empty path is not a permission`,
        'empty_permission_entry',
        { key },
      )
    }
    if (text === '*' || text === '**' || text === '/**') {
      throw new SkillPermissionError(
        `${source} asks for '${text}' in '${key}'; a wildcard is not a scope, say which directory`,
        'wildcard_scope',
        { key },
      )
    }
    roots.push(resolve(text))
  }
  return { [key]: Object.freeze([...new Set(roots)].sort()) }
}

function normaliseNetwork(value, source) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') {
    throw new SkillPermissionError(
      `${source} declares network as '${value}'; it must be true or false, not a string that ` +
        'reads like consent',
      'invalid_permission_value',
      { value },
    )
  }
  return value
}

/**
 * Parse and validate the declaration straight out of a skill document's text.
 *
 * This is the function that lets an executor be rebuilt from the registry alone: the
 * permission a procedure runs with is re-read from the stored document rather than remembered
 * from the process that installed it.
 */
export function permissionsFromDocument(text) {
  const { frontmatter, errors } = parseFrontmatter(text)
  if (!frontmatter) {
    throw new SkillPermissionError(
      `cannot read a permission declaration: ${errors[0] ?? 'the document has no frontmatter'}`,
      'no_frontmatter',
      { errors },
    )
  }
  return declarationFrom(frontmatter, { source: `'${frontmatter.name ?? 'unnamed skill'}'` })
}

/** Is `path` inside `root`? A prefix match on text is not enough: `/tmp/a` is not `/tmp/ab`. */
export function withinRoot(root, path) {
  const target = resolve(String(path))
  const base = resolve(String(root))
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

function rootOf(declaration, key) {
  return declaration?.[key] ?? []
}

/** The first declared root the grant does not cover, or null when the declaration fits. */
export function wideningReason(declaration, grant) {
  const granted = rootOf(grant ?? NO_PERMISSIONS, 'fsRead')
  for (const root of rootOf(declaration, 'fsRead')) {
    if (!granted.some((allowed) => withinRoot(allowed, root))) {
      return {
        kind: 'fsRead',
        asked: root,
        allowed: [...granted],
        describe: `read access to ${root}`,
      }
    }
  }
  const grantedWrites = rootOf(grant ?? NO_PERMISSIONS, 'fsWrite')
  for (const root of rootOf(declaration, 'fsWrite')) {
    if (!grantedWrites.some((allowed) => withinRoot(allowed, root))) {
      return {
        kind: 'fsWrite',
        asked: root,
        allowed: [...grantedWrites],
        describe: `write access to ${root}`,
      }
    }
  }
  if (declaration?.network === true && grant?.network !== true) {
    return { kind: 'network', asked: true, allowed: false, describe: 'network access' }
  }
  return null
}

/** A sentence a human can act on: what the skill declares, and whether it fits. */
export function describePermissions(declaration) {
  const read = rootOf(declaration, 'fsRead')
  const write = rootOf(declaration, 'fsWrite')
  return [
    read.length ? `reads ${read.join(', ')}` : 'reads nothing',
    write.length ? `writes ${write.join(', ')}` : 'writes nothing',
    declaration?.network === true ? 'may use the network' : 'no network',
  ].join(', ')
}

/**
 * The scope a procedure runs with: its own declaration, and only if the runtime allows it.
 *
 * Returns the declaration itself rather than an intersection, because a declaration that fits
 * inside the grant *is* the intersection, and when it does not fit this refuses rather than
 * quietly running with less than the document promised.
 */
export function effectivePermissions(declaration, grant, { name = 'the skill', createdBy = null } = {}) {
  assertNotUnrestricted(declaration, { name, createdBy })
  const widening = wideningReason(declaration, grant)
  if (widening) {
    throw new SkillPermissionError(
      `'${name}' declares ${widening.describe}, and the runtime grant does not allow it ` +
        `(granted: ${describePermissions(grant ?? NO_PERMISSIONS)}). Grant it or change the document; ` +
        'the procedure will not be run with a scope it did not declare.',
      'permission_widening',
      { skill: name, widening, declaration, grant },
    )
  }
  return declaration
}

/**
 * A skill the system wrote may not ask for the machine.
 *
 * This is scoped to `createdBy: 'agent'` on purpose. A human writing a skill by hand is
 * trusted to decide what they want; an agent that inferred a procedure from one successful
 * task is not, and the whole point of the rule is that the inference cannot widen its own
 * reach. `/`, the home directory and the network are the three ways a narrow-looking
 * procedure becomes a general one.
 */
export function assertNotUnrestricted(declaration, { name = 'the skill', createdBy = null } = {}) {
  if (createdBy !== 'agent') return
  const home = resolve(homedir())
  for (const root of rootOf(declaration, 'fsRead')) {
    if (root === resolve(sep) || withinRoot(root, home)) {
      throw new SkillPermissionError(
        `'${name}' was written by the agent and asks to read ${root}, which covers the whole ` +
          'home directory or filesystem. A procedure learned from one task has no business ' +
          'asking for the machine; name the directory it actually needs.',
        'unrestricted_read_scope',
        { skill: name, root },
      )
    }
  }
  for (const root of rootOf(declaration, 'fsWrite')) {
    if (root === resolve(sep) || withinRoot(root, home)) {
      throw new SkillPermissionError(
        `'${name}' was written by the agent and asks to write ${root}, which covers the whole ` +
          'home directory or filesystem',
        'unrestricted_write_scope',
        { skill: name, root },
      )
    }
  }
  if (declaration?.network === true) {
    throw new SkillPermissionError(
      `'${name}' was written by the agent and asks for network access; a learned procedure may ` +
        'not reach the network without a human granting it',
      'network_not_allowed',
      { skill: name },
    )
  }
}

/** A frozen declaration, for callers building one in code rather than reading a document. */
export function frozenDeclaration({ fsRead = [], fsWrite = [], network = false } = {}) {
  return Object.freeze({
    fsRead: Object.freeze([...fsRead]),
    fsWrite: Object.freeze([...fsWrite]),
    network: network === true,
  })
}

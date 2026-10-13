// A dependency-free JSON Schema (draft-07 subset) validator.
//
// Used to validate MCP tool arguments and outputs, and plugin capability schemas,
// before any handler executes. Directive §2 (MCP): "Provide schema validation …
// Do not assume every MCP server or tool is trustworthy."
//
// Supported keywords: type, enum, const, required, properties, additionalProperties,
// items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum,
// exclusiveMinimum, exclusiveMaximum, multipleOf, format (a few), anyOf, oneOf, allOf, not.
// Anything unrecognised is reported rather than silently ignored, so a schema that
// claims more safety than this validator provides cannot pass unnoticed.

const KNOWN_KEYWORDS = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'format', 'anyOf', 'oneOf',
  'allOf', 'not', 'title', 'description', 'default', 'examples', '$schema', '$id',
  'definitions', '$defs', '$ref', 'nullable',
])

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

export class SchemaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SchemaError'
    this.code = 'invalid_schema'
  }
}

/** Validate the schema document itself, so a bad schema fails loudly. */
export function assertValidSchema(schema, path = '#') {
  if (schema === true || schema === false) return
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new SchemaError(`${path}: schema must be an object or a boolean`)
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    for (const type of types) if (!TYPES.has(type)) throw new SchemaError(`${path}: unknown type '${type}'`)
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length) throw new SchemaError(`${path}: enum must be a non-empty array`)
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw new SchemaError(`${path}: required must be an array`)
    const props = schema.properties ? Object.keys(schema.properties) : null
    for (const key of schema.required) {
      if (typeof key !== 'string') throw new SchemaError(`${path}: required entries must be strings`)
      if (props && !props.includes(key)) throw new SchemaError(`${path}: required property '${key}' is not declared in properties`)
    }
  }
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new SchemaError(`${path}: properties must be an object`)
    }
    for (const [key, sub] of Object.entries(schema.properties)) assertValidSchema(sub, `${path}/properties/${key}`)
  }
  if (schema.items !== undefined) assertValidSchema(schema.items, `${path}/items`)
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
    assertValidSchema(schema.additionalProperties, `${path}/additionalProperties`)
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[keyword] !== undefined) {
      if (!Array.isArray(schema[keyword]) || !schema[keyword].length) throw new SchemaError(`${path}: ${keyword} must be a non-empty array`)
      schema[keyword].forEach((sub, i) => assertValidSchema(sub, `${path}/${keyword}/${i}`))
    }
  }
  if (schema.not !== undefined) assertValidSchema(schema.not, `${path}/not`)
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern)
    } catch {
      throw new SchemaError(`${path}: invalid regular expression '${schema.pattern}'`)
    }
  }
  if (schema.$ref !== undefined) {
    throw new SchemaError(`${path}: $ref is not supported by this validator; inline the referenced schema`)
  }
  const unknown = Object.keys(schema).filter((key) => !KNOWN_KEYWORDS.has(key))
  if (unknown.length) throw new SchemaError(`${path}: unsupported keyword(s) ${unknown.join(', ')} — refusing to pretend they are enforced`)
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(value, expected) {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  if (expected === 'integer') return actual === 'integer'
  return actual === expected
}

const FORMAT_CHECKS = {
  'date-time': (v) => !Number.isNaN(Date.parse(v)),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: (v) => {
    try {
      // eslint-disable-next-line no-new
      new URL(v)
      return true
    } catch {
      return false
    }
  },
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  ipv4: (v) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((part) => Number(part) <= 255),
}

/**
 * Validate a value against a schema.
 * @returns {{valid:boolean, errors:string[], value:*}} errors use JSON-pointer paths.
 */
export function validateAgainstSchema(value, schema, path = '#') {
  if (schema === undefined || schema === null) {
    return { valid: false, errors: [`${path}: no schema supplied — refusing to accept unvalidated input`], value }
  }
  if (schema === true) return { valid: true, errors: [], value }
  if (schema === false) return { valid: false, errors: [`${path}: schema forbids any value`], value }

  let errors = []

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = expected.some((type) => matchesType(value, type)) || (schema.nullable === true && value === null)
    if (!ok) errors.push(`${path}: expected type ${expected.join('|')} but got ${typeOf(value)}`)
  }

  if (schema.enum !== undefined && !schema.enum.some((entry) => deepEqual(entry, value))) {
    errors.push(`${path}: value must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${path}: value must equal ${JSON.stringify(schema.const)}`)
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than minLength ${schema.minLength}`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength ${schema.maxLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`)
    if (schema.format && FORMAT_CHECKS[schema.format] && !FORMAT_CHECKS[schema.format](value)) errors.push(`${path}: is not a valid ${schema.format}`)
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`)
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`)
    if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) errors.push(`${path}: ${value} is not a multiple of ${schema.multipleOf}`)
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than minItems ${schema.minItems}`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than maxItems ${schema.maxItems}`)
    if (schema.items) {
      value.forEach((entry, index) => {
        errors = errors.concat(validateAgainstSchema(entry, schema.items, `${path}/${index}`).errors)
      })
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value) || value[key] === undefined) errors.push(`${path}: missing required property '${key}'`)
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value && value[key] !== undefined) {
          errors = errors.concat(validateAgainstSchema(value[key], sub, `${path}/${key}`).errors)
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const extra = Object.keys(value).filter((key) => !(key in schema.properties))
      if (extra.length) errors.push(`${path}: unexpected propert${extra.length === 1 ? 'y' : 'ies'} ${extra.join(', ')}`)
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const declared = new Set(Object.keys(schema.properties ?? {}))
      for (const [key, entry] of Object.entries(value)) {
        if (!declared.has(key)) errors = errors.concat(validateAgainstSchema(entry, schema.additionalProperties, `${path}/${key}`).errors)
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((sub, i) => {
      errors = errors.concat(validateAgainstSchema(value, sub, `${path}<allOf/${i}>`).errors)
    })
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((sub) => validateAgainstSchema(value, sub, path).valid)
    if (!ok) errors.push(`${path}: does not match any of the anyOf schemas`)
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((sub) => validateAgainstSchema(value, sub, path).valid).length
    if (matches !== 1) errors.push(`${path}: must match exactly one oneOf schema, matched ${matches}`)
  }
  if (schema.not !== undefined && validateAgainstSchema(value, schema.not, path).valid) {
    errors.push(`${path}: must NOT match the 'not' schema`)
  }

  return { valid: errors.length === 0, errors, value }
}

/**
 * Apply declared defaults and strip undeclared properties, so a handler receives
 * exactly the shape its schema promises. Returns the sanitised value.
 */
export function coerceToSchema(value, schema) {
  const { valid } = validateAgainstSchema(value, schema)
  if (!valid) return { ok: false, value }
  if (!schema || typeof schema !== 'object' || schema.type !== 'object' || !schema.properties) return { ok: true, value }
  const out = {}
  for (const [key, sub] of Object.entries(schema.properties)) {
    if (value && key in value && value[key] !== undefined) out[key] = value[key]
    else if (sub && typeof sub === 'object' && 'default' in sub) out[key] = structuredClone(sub.default)
  }
  if (schema.additionalProperties !== false && value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) if (!(key in schema.properties)) out[key] = entry
  }
  return { ok: true, value: out }
}

export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, i) => deepEqual(entry, b[i]))
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((key) => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

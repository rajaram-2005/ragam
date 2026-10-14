// The five product areas.
//
// This list IS the product surface. Everything else the platform does — model
// routing, private memory, safety classification, model management, God Core
// orchestration, training, benchmarking, resource management, execution control —
// is an internal service rendered inside one of these five areas, never as a
// sixth navigation entry.
//
// Upstream Aetheris exposed twelve sections (see _audit/Aetheris-/src/main.jsx:73-86).
// The mapping that reduced them is recorded here so the decision is auditable:
//
//   command + coding + knowledge   -> chat      (conversation, retrieval, tasks)
//   studio-image                   -> image
//   studio-video                   -> video
//   plugins                        -> plugins
//   mcp                            -> mcp
//   observability, architecture, workflows, agents, models, devices
//                                -> internal; no navigation entry
//
// Kept in a plain .js module rather than in Shell.jsx so the structural tests can
// import it: Node cannot parse JSX, and "exactly five areas" is a requirement worth
// testing rather than eyeballing.

export const AREAS = Object.freeze([
  { id: 'chat', label: 'Chat', hint: 'online models · knowledge · history', glyph: '◈' },
  { id: 'image', label: 'Image', hint: 'generation · validation', glyph: '▣' },
  { id: 'video', label: 'Video', hint: 'generation · provenance', glyph: '▶' },
  { id: 'plugins', label: 'Plugins', hint: 'manifests · permissions', glyph: '⬡' },
  { id: 'mcp', label: 'MCP', hint: 'servers · tools · gates', glyph: '⇄' },
].map((area) => Object.freeze(area)))

export const AREA_IDS = Object.freeze(AREAS.map((area) => area.id))

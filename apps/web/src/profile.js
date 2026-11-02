const PROFILE_KEY = 'ragam.local-profile.v1'

const GENERIC = Object.freeze([
  { id: 'clarify', title: 'Make a complex idea clear', detail: 'Build an explanation from first principles', prompt: 'Help me explain this complex idea clearly. Start from first principles, use a concrete example, and point out what you are uncertain about: ' },
  { id: 'draft', title: 'Shape a first draft', detail: 'Turn rough notes into a useful starting point', prompt: 'Turn these rough notes into a clear first draft. Preserve my meaning and flag any assumptions: ' },
  { id: 'compare', title: 'Compare the options', detail: 'Lay out trade-offs without choosing for me', prompt: 'Compare these options using the criteria I give you. Show the trade-offs and do not choose for me: ' },
  { id: 'plan', title: 'Make a practical plan', detail: 'Break a goal into manageable next steps', prompt: 'Help me turn this goal into a practical sequence of small steps. Ask me about constraints you need: ' },
])

const RECOMMENDATIONS = [
  {
    matches: ['teacher', 'educator', 'professor', 'instructor', 'tutor', 'teaching'],
    items: [
      ['lesson', 'Plan a lesson', 'Create a clear structure with checks for understanding', 'Help me plan a lesson about [topic] for [age or level]. Give me a learning goal, a short explanation, an activity, and a quick check for understanding.'],
      ['adapt', 'Adapt an explanation', 'Make a concept accessible to different learners', 'Explain [concept] for learners at [level]. Give one analogy, one concrete example, and a simpler alternative without changing the facts.'],
      ['quiz', 'Draft practice questions', 'Create questions with answer guidance', 'Draft five practice questions about [topic], with an answer key and a note about what each question checks.'],
      ['feedback', 'Improve feedback', 'Make comments specific and constructive', 'Help me make this feedback specific, kind, and actionable. Do not invent facts about the learner: '],
    ],
  },
  {
    matches: ['developer', 'software', 'programmer', 'engineer', 'engineering', 'it '],
    items: [
      ['debug', 'Trace a bug', 'Work from observed behavior and evidence', 'Help me debug this issue. First list plausible causes, then suggest the smallest checks to distinguish them. Here are the symptoms and relevant code: '],
      ['design', 'Review a design', 'Compare constraints and failure cases', 'Review this technical design for assumptions, failure modes, security risks, and simpler alternatives. Do not claim tests were run: '],
      ['tests', 'Plan test cases', 'Cover normal, boundary, and failure paths', 'Suggest tests for this change, including normal behavior, edge cases, and failure handling. Keep the tests tied to these requirements: '],
      ['explain-code', 'Explain unfamiliar code', 'Follow data flow and name uncertainties', 'Explain what this code does by tracing its inputs, key steps, and outputs. Point out anything that cannot be concluded from the snippet: '],
    ],
  },
  {
    matches: ['student', 'researcher', 'research', 'academic', 'scholar', 'learner'],
    items: [
      ['study', 'Build a study plan', 'Divide a topic into review sessions', 'Build a study plan for [topic] over [time available]. Include short review sessions and ways I can test my understanding.'],
      ['concepts', 'Unpack a concept', 'Connect definitions to examples', 'Teach me [concept] step by step. Define key terms, give an example, then ask me one question to check my understanding.'],
      ['paper', 'Organize research notes', 'Separate evidence, claims, and open questions', 'Organize these notes into claims, supporting evidence, disagreements, and open questions. Do not add sources or facts: '],
      ['quiz', 'Practice retrieval', 'Generate questions before revealing answers', 'Quiz me on [topic] one question at a time. Wait for my answer before giving feedback.'],
    ],
  },
  {
    matches: ['writer', 'editor', 'journalist', 'content', 'marketing', 'communications', 'copywriter'],
    items: [
      ['outline', 'Shape an outline', 'Give a draft a clearer structure', 'Create an outline for [audience] about [topic]. Keep the main point clear and mark where evidence is needed.'],
      ['edit', 'Edit for clarity', 'Preserve your meaning and voice', 'Edit this draft for clarity and flow while preserving my meaning and voice. List substantive changes separately: '],
      ['audience', 'Adapt for an audience', 'Change level and format, not the facts', 'Adapt this text for [audience] in [format]. Keep factual claims unchanged and flag anything that needs verification: '],
      ['ideas', 'Generate angles', 'Explore directions without inventing evidence', 'Suggest four distinct angles for this piece. For each, name the audience and what evidence I would need: '],
    ],
  },
  {
    matches: ['manager', 'lead', 'founder', 'business', 'owner', 'operations', 'sales'],
    items: [
      ['meeting', 'Prepare a meeting brief', 'Clarify the decision and the open questions', 'Turn these notes into a meeting brief with the decision needed, known facts, open questions, and next steps: '],
      ['process', 'Map a process', 'Find handoffs and likely bottlenecks', 'Help me map this process into steps, owners, handoffs, and possible bottlenecks. Separate what I stated from what you infer: '],
      ['options', 'Compare approaches', 'Make costs and trade-offs visible', 'Compare these approaches using my constraints. Show benefits, costs, risks, and what information is missing: '],
      ['communication', 'Draft a clear update', 'Make status and asks easy to scan', 'Draft a concise update from these notes with progress, blockers, decisions needed, and next actions: '],
    ],
  },
  {
    matches: ['doctor', 'nurse', 'clinician', 'healthcare', 'medical', 'therapist', 'pharmacist'],
    items: [
      ['plain-language', 'Simplify approved material', 'Keep source meaning and uncertainty intact', 'Rewrite this provided material in plain language for [audience]. Do not add clinical advice or change its meaning: '],
      ['admin', 'Organize a workflow', 'Turn a supplied process into a checklist', 'Turn this supplied administrative process into a checklist. Preserve all warnings and identify unclear steps: '],
      ['questions', 'Prepare questions for a qualified professional', 'Organize concerns without answering them', 'Help me organize these concerns into neutral questions to discuss with a qualified healthcare professional. Do not diagnose or recommend treatment: '],
      ['summary', 'Summarize supplied notes', 'Separate documented facts from unknowns', 'Summarize these supplied notes. Separate documented information, uncertainties, and follow-up questions; do not infer a diagnosis: '],
    ],
  },
  {
    matches: ['lawyer', 'attorney', 'legal', 'paralegal', 'solicitor'],
    items: [
      ['organize', 'Organize case materials', 'Separate dates, sources, and open questions', 'Organize these supplied notes into a dated chronology, source references, and open questions. Do not make legal conclusions: '],
      ['plain-language', 'Explain supplied text', 'Identify terms to verify with counsel', 'Explain this supplied text in plain language and list terms or consequences that a qualified lawyer should verify: '],
      ['draft', 'Structure a draft', 'Keep facts distinct from assumptions', 'Help structure this draft for clarity. Preserve the supplied facts, mark assumptions, and do not add legal claims: '],
      ['checklist', 'Prepare a review checklist', 'Identify missing information for human review', 'Create a checklist of information a qualified legal professional may need to review this matter: '],
    ],
  },
  {
    matches: ['designer', 'design', 'artist', 'creative', 'architect', 'illustrator'],
    items: [
      ['brief', 'Shape a creative brief', 'Clarify audience, constraints, and goals', 'Turn these notes into a creative brief with audience, goal, constraints, deliverables, and unresolved questions: '],
      ['concepts', 'Explore concept directions', 'Generate distinct starting points', 'Suggest four distinct concept directions for [project]. For each, include a short rationale and a question to validate it.'],
      ['feedback', 'Structure design feedback', 'Make feedback concrete and usable', 'Rewrite this feedback as specific observations, user impact, and a possible next step without dictating the final design: '],
      ['accessibility', 'Review accessibility questions', 'Create a checklist for human review', 'Create an accessibility review checklist for this design and identify what needs testing with users or assistive technology: '],
    ],
  },
]

const emptyProfile = () => ({ name: '', profession: '' })

function safeStorage() {
  try { return globalThis.localStorage ?? null } catch { return null }
}

export function normalizeProfile(value = {}) {
  return {
    name: String(value?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
    profession: String(value?.profession ?? '').trim().replace(/\s+/g, ' ').slice(0, 100),
  }
}

export function readProfile(storage = safeStorage()) {
  if (!storage) return emptyProfile()
  try {
    const parsed = JSON.parse(storage.getItem(PROFILE_KEY) ?? '{}')
    return normalizeProfile(parsed)
  } catch { return emptyProfile() }
}

export function writeProfile(value, storage = safeStorage()) {
  const profile = normalizeProfile(value)
  if (!storage) throw new Error('This browser is not allowing local profile storage.')
  if (profile.name || profile.profession) storage.setItem(PROFILE_KEY, JSON.stringify(profile))
  else storage.removeItem(PROFILE_KEY)
  return profile
}

export function recommendationsForProfile(value) {
  const profile = normalizeProfile(value)
  const profession = profile.profession.toLocaleLowerCase()
  const match = RECOMMENDATIONS.find(({ matches }) => matches.some((word) => profession.includes(word)))
  const rows = match?.items ?? GENERIC.map(({ id, title, detail, prompt }) => [id, title, detail, prompt])
  return rows.map(([id, title, detail, prompt], index) => ({
    id,
    number: String(index + 1).padStart(2, '0'),
    title,
    detail,
    prompt: profile.profession && !match
      ? `${prompt}\n\nMy profession is ${profile.profession}. Use that context only for relevance; ask me if you need specifics. `
      : prompt,
  }))
}

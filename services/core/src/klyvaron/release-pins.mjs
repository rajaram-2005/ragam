// Release pins for the first-party Klyvaron artifacts this build ships.
//
// Why these exist: every artifact carries its own manifest, and the loaders
// verify the weights file against the hash *inside that manifest*. That check
// is self-referential — an attacker (or a corrupt mirror) who replaces both
// files consistently passes it. The pins below are the released file digests,
// recorded in source control at release time, so an artifact that merely
// *claims* to be the released version must also *be* it, byte for byte.
//
// Scope discipline: a pin applies only when an artifact claims the pinned
// release version. Locally retrained artifacts carry a distinct version
// (`0.1.0-local.<job>` from the training worker) and are verified by the
// ordinary manifest/architecture/inference gates instead — the pin must
// never become a reason a legitimate local retrain cannot load, and a local
// retrain must never be able to impersonate the release by reusing its
// version string.
//
// Provenance of the values: SHA-256 of the released files as published for
// `klyvaron-*-0.1.0` (see docs/model-cards/ and docs/03-status.md), verified
// against the packaged `SHA256SUMS` of the weights tarball in CI.

export const KLYVARON_RELEASE_PINS = Object.freeze({
  'klyvaron-pro-lm': Object.freeze({
    version: '0.1.0',
    weightsFile: 'klyvaron-pro-lm-0.1.0.npz',
    weightsSha256: '23260d34ab8a939c84f9a48175fa4481d785bfce6b9a2895944ad34e6df2f97d',
  }),
  'klyvaron-max-lm': Object.freeze({
    version: '0.1.0',
    weightsFile: 'klyvaron-max-lm-0.1.0.npz',
    weightsSha256: '5baf7223006eb9cc1927cd32e16f2d1542a823959c820e7ce9fa919d5d7c6150',
  }),
  'klyvaron-pro-image': Object.freeze({
    version: '0.1.0',
    weightsFile: 'weights.npz',
    weightsSha256: 'be4f4d8c4d6aece3d2f9768f2464a41e70f7203d0ef282cff95228e6db7a50fa',
    processorFile: 'processor.json',
    processorSha256: 'e3e153d7fa923389222f795998f917d23e7f85d878de758d96a56884562ee6d3',
  }),
  'klyvaron-max-image': Object.freeze({
    version: '0.1.0',
    weightsFile: 'weights.npz',
    weightsSha256: 'ce5e12c6ac7bb897c34248191ee149d2e3ae31cc8c856688ace6827f46c4781b',
    processorFile: 'processor.json',
    processorSha256: 'e3e153d7fa923389222f795998f917d23e7f85d878de758d96a56884562ee6d3',
  }),
  'klyvaron-pro-video': Object.freeze({
    version: '0.1.0',
    weightsFile: 'weights.npz',
    weightsSha256: 'e96666360581a832a39e2ea9101177365bde3e22747afa9f0d3151bb44962e45',
    processorFile: 'processor.json',
    processorSha256: 'd304605de3be7945e0863d819e205b5f1acab7e5878ff0f45694b66b5b47e1ec',
  }),
  'klyvaron-max-video': Object.freeze({
    version: '0.1.0',
    weightsFile: 'weights.npz',
    weightsSha256: '17c4c51f0db941d7c70b465da6e941049e6e3939b36303eb0f9ba9e6bb861dd3',
    processorFile: 'processor.json',
    processorSha256: '78d53968ccda73c670cfc272341aa44a835e17dda894fab4976605af7c55b1f3',
  }),
  'klyvaron-pro-voice': Object.freeze({
    version: '0.1.0',
    weightsFile: 'weights.npz',
    weightsSha256: 'd50a346cce8c48f32d03bca0567a83c8654bf3f305082e073ef156381abee7db',
    processorFile: 'processor.json',
    processorSha256: 'e6f57b41688363ad9a091a51b5d9f1ba3fec3d237b654e8e58d8e5dbce7d2323',
  }),
  'klyvaron-max-voice': Object.freeze({
    version: '0.1.0',
    weightsFile: 'weights.npz',
    weightsSha256: '0ca20f985f4466d180dcf3a13b89658ffa6eb5b81cd4184e53d714efff27ee1d',
    processorFile: 'processor.json',
    processorSha256: '0d01eb720288361081f6e8514f9b079ab00432fc091596108ad9279bb739271e',
  }),
})

/**
 * Why an artifact may not serve under its claimed release identity, or null.
 *
 * Pure and total: returns null when no pin covers `id`, or when the artifact
 * does not claim the pinned version. All hashes passed in must be computed
 * from the files on disk by the caller — never read back from the artifact's
 * own manifest, which is the thing being checked.
 */
export function releasePinViolation({ id, version, weightsFile = null, weightsSha256 = null, processorFile = null, processorSha256 = null } = {}) {
  const pin = KLYVARON_RELEASE_PINS[id]
  if (!pin) return null
  if (version !== pin.version) return null
  if (weightsFile !== pin.weightsFile) {
    return `${id}@${pin.version} must ship weights file '${pin.weightsFile}', not '${weightsFile}'`
  }
  if (weightsSha256 !== pin.weightsSha256) {
    return `${id}@${pin.version} weights SHA-256 ${weightsSha256} does not match the released pin ${pin.weightsSha256}`
  }
  if (pin.processorSha256) {
    if (processorFile !== pin.processorFile) {
      return `${id}@${pin.version} must ship processor file '${pin.processorFile}', not '${processorFile}'`
    }
    if (processorSha256 !== pin.processorSha256) {
      return `${id}@${pin.version} processor SHA-256 ${processorSha256} does not match the released pin ${pin.processorSha256}`
    }
  }
  return null
}

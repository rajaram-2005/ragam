# Model card — klyvaron-max-voice 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-max-voice@0.1.0` |
| **Family** | `klyvaron-max` |
| **Modality** | `voice` |
| **Architecture** | `aetheris-voice-v1` (`11,257,231` parameters) |
| **Status** | `released` (`0` hard failures) |
| **Licence** | MIT — trained from random initialisation (`baseCheckpoint: null`) |
| **Weights SHA-256** | `50ed3ed517bb3c7a295f2e63dc3d028e16f983669ffd887da538f508fe44a150` |
| **Package SHA-256** | `0ca20f985f4466d180dcf3a13b89658ffa6eb5b81cd4184e53d714efff27ee1d` (`20,795,409` bytes) |
| **Supported tasks** | `speech.transcribe, speech.synthesize` |
| **Unsupported tasks** | `multi_speaker_overlapping_diarization, zero_shot_voice_cloning, multilingual_far_field_noisy_dictation, full_duplex_sub_50ms_streaming_telephony` |

## Held-out Evaluation Metrics

- **`validationUtteranceAccuracy`**: `1.0`
- **`uniformUtteranceBaseline`**: `0.0833`
- **`validationCharacterErrorRate`**: `0.1914`
- **`roundTripTtsToAsrCer`**: `0.0958`
- **`validationTtsMelL1`**: `0.1707`
- **`meanSpectrumBaselineL1`**: `0.249`
- **`initialLoss`**: `8.5176`
- **`finalLoss`**: `0.7837`
- **`lossImprovement`**: `7.734`
- **`steps`**: `240`
- **`wallSeconds`**: `486.524`
- **`parameterCount`**: `11257231`

## Known Limitations

- Trained on 16 kHz mono multi-formant speech (288 multi-pitch training utterances, 120 held-out unseen-speaker utterances across 12 phrase classes and 34-symbol character vocabulary).
- Multi-speaker overlapping diarization, zero-shot voice cloning, and noisy far-field multilingual dictation are unsupported.
- Both speech input (`speech.transcribe`) and speech output (`speech.synthesize`) are executed by first-party weights and evaluated with round-trip CER.

## Intended Use & Out-of-Scope Limitations

- **Intended use**: local/worker execution of `speech.transcribe, speech.synthesize` in RAGAM.
- **Out of scope**: `multi_speaker_overlapping_diarization, zero_shot_voice_cloning, multilingual_far_field_noisy_dictation, full_duplex_sub_50ms_streaming_telephony`.

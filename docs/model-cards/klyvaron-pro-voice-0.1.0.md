# Model card — klyvaron-pro-voice 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-pro-voice@0.1.0` |
| **Family** | `klyvaron-pro` |
| **Modality** | `voice` |
| **Architecture** | `aetheris-voice-v1` (`3,076,311` parameters) |
| **Status** | `released` (`0` hard failures) |
| **Licence** | MIT — trained from random initialisation (`baseCheckpoint: null`) |
| **Weights SHA-256** | `5cced1f528162c0c65806a7a9c4740a7a059780ee954d8948f3267c35a5d3753` |
| **Package SHA-256** | `d50a346cce8c48f32d03bca0567a83c8654bf3f305082e073ef156381abee7db` (`5,699,324` bytes) |
| **Supported tasks** | `speech.transcribe, speech.synthesize` |
| **Unsupported tasks** | `multi_speaker_overlapping_diarization, zero_shot_voice_cloning, multilingual_far_field_noisy_dictation, full_duplex_sub_50ms_streaming_telephony` |

## Held-out Evaluation Metrics

- **`validationUtteranceAccuracy`**: `1.0`
- **`uniformUtteranceBaseline`**: `0.0833`
- **`validationCharacterErrorRate`**: `0.159`
- **`roundTripTtsToAsrCer`**: `0.0549`
- **`validationTtsMelL1`**: `0.1695`
- **`meanSpectrumBaselineL1`**: `0.2487`
- **`initialLoss`**: `10.6513`
- **`finalLoss`**: `0.8219`
- **`lossImprovement`**: `9.8294`
- **`steps`**: `240`
- **`wallSeconds`**: `175.061`
- **`parameterCount`**: `3076311`

## Known Limitations

- Trained on 16 kHz mono multi-formant speech (288 multi-pitch training utterances, 120 held-out unseen-speaker utterances across 12 phrase classes and 34-symbol character vocabulary).
- Multi-speaker overlapping diarization, zero-shot voice cloning, and noisy far-field multilingual dictation are unsupported.
- Both speech input (`speech.transcribe`) and speech output (`speech.synthesize`) are executed by first-party weights and evaluated with round-trip CER.

## Intended Use & Out-of-Scope Limitations

- **Intended use**: local/worker execution of `speech.transcribe, speech.synthesize` in RAGAM.
- **Out of scope**: `multi_speaker_overlapping_diarization, zero_shot_voice_cloning, multilingual_far_field_noisy_dictation, full_duplex_sub_50ms_streaming_telephony`.

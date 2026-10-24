# Model card — klyvaron-max-video 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-max-video@0.1.0` |
| **Family** | `klyvaron-max` |
| **Modality** | `video` |
| **Architecture** | `aetheris-video-v1` (`8,134,602` parameters) |
| **Status** | `released` (`0` hard failures) |
| **Licence** | MIT — trained from random initialisation (`baseCheckpoint: null`) |
| **Weights SHA-256** | `229bbce13cf27b19204533558373bccdc4d540d0fd0cc8edacdd9a8a3ab5f705` |
| **Package SHA-256** | `17c4c51f0db941d7c70b465da6e941049e6e3939b36303eb0f9ba9e6bb861dd3` (`15,035,795` bytes) |
| **Supported tasks** | `video.generate, video.understand` |
| **Unsupported tasks** | `long_form_multi_minute_video_synthesis, synchronized_audio_video_foley_generation, photorealistic_human_character_acting, 4k_60fps_cinematic_rendering` |

## Held-out Evaluation Metrics

- **`validationMotionAccuracy`**: `0.8229`
- **`uniformMotionBaseline`**: `0.1667`
- **`validationEnvironmentAccuracy`**: `0.9583`
- **`uniformEnvironmentBaseline`**: `0.25`
- **`generationMotionAlignmentAccuracy`**: `0.2083`
- **`generationEnvironmentAlignmentAccuracy`**: `0.0833`
- **`validationFrameL1`**: `0.1694`
- **`staticBaselineFrameL1`**: `0.1641`
- **`initialLoss`**: `7.604`
- **`finalLoss`**: `2.3111`
- **`lossImprovement`**: `5.2928`
- **`steps`**: `160`
- **`wallSeconds`**: `261.992`
- **`parameterCount`**: `8134602`

## Known Limitations

- Trained on 6 physical motion trajectories x 4 visual environments (240 training clips, 96 held-out clips, 24 native frames).
- Long-form multi-minute cinema synthesis, synchronized audio-video foley tracks, and photorealistic human acting are not supported.
- Outputs are genuine H.264 ISO-BMFF MP4 clips verified for non-zero temporal motion and valid moov/mvhd duration.

## Intended Use & Out-of-Scope Limitations

- **Intended use**: local/worker execution of `video.generate, video.understand` in RAGAM.
- **Out of scope**: `long_form_multi_minute_video_synthesis, synchronized_audio_video_foley_generation, photorealistic_human_character_acting, 4k_60fps_cinematic_rendering`.

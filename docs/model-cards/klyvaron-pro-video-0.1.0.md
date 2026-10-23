# Model card — klyvaron-pro-video 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-pro-video@0.1.0` |
| **Family** | `klyvaron-pro` |
| **Modality** | `video` |
| **Architecture** | `aetheris-video-v1` (`2,221,482` parameters) |
| **Status** | `released` (`0` hard failures) |
| **Licence** | MIT — trained from random initialisation (`baseCheckpoint: null`) |
| **Weights SHA-256** | `600270d1e34e169659b4df01e9d4b13288567a508f3b42738057ac4ebcdbb4ec` |
| **Package SHA-256** | `e96666360581a832a39e2ea9101177365bde3e22747afa9f0d3151bb44962e45` (`4,122,280` bytes) |
| **Supported tasks** | `video.generate, video.understand` |
| **Unsupported tasks** | `long_form_multi_minute_video_synthesis, synchronized_audio_video_foley_generation, photorealistic_human_character_acting, 4k_60fps_cinematic_rendering` |

## Held-out Evaluation Metrics

- **`validationMotionAccuracy`**: `1.0`
- **`uniformMotionBaseline`**: `0.1667`
- **`validationEnvironmentAccuracy`**: `1.0`
- **`uniformEnvironmentBaseline`**: `0.25`
- **`generationMotionAlignmentAccuracy`**: `0.1667`
- **`generationEnvironmentAlignmentAccuracy`**: `1.0`
- **`validationFrameL1`**: `0.0908`
- **`staticBaselineFrameL1`**: `0.1546`
- **`initialLoss`**: `6.7421`
- **`finalLoss`**: `1.3317`
- **`lossImprovement`**: `5.4104`
- **`steps`**: `160`
- **`wallSeconds`**: `88.408`
- **`parameterCount`**: `2221482`

## Known Limitations

- Trained on 6 physical motion trajectories x 4 visual environments (240 training clips, 96 held-out clips, 16 native frames).
- Long-form multi-minute cinema synthesis, synchronized audio-video foley tracks, and photorealistic human acting are not supported.
- Outputs are genuine H.264 ISO-BMFF MP4 clips verified for non-zero temporal motion and valid moov/mvhd duration.

## Intended Use & Out-of-Scope Limitations

- **Intended use**: local/worker execution of `video.generate, video.understand` in RAGAM.
- **Out of scope**: `long_form_multi_minute_video_synthesis, synchronized_audio_video_foley_generation, photorealistic_human_character_acting, 4k_60fps_cinematic_rendering`.

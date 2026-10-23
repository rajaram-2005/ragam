# Model card — klyvaron-pro-image 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-pro-image@0.1.0` |
| **Family** | `klyvaron-pro` |
| **Modality** | `image` |
| **Architecture** | `aetheris-image-v1` (`3,728,352` parameters) |
| **Status** | `released` (`0` hard failures) |
| **Licence** | MIT — trained from random initialisation (`baseCheckpoint: null`) |
| **Weights SHA-256** | `c53918a3c97a762552c639a32d7d58fdada4c56728636df8b768097731f5fd0f` |
| **Package SHA-256** | `be4f4d8c4d6aece3d2f9768f2464a41e70f7203d0ef282cff95228e6db7a50fa` (`6,904,693` bytes) |
| **Supported tasks** | `image.generate, image.edit, vision.understand` |
| **Unsupported tasks** | `photorealistic_megapixel_open_world_synthesis, typographic_text_rendering_in_images, multi_subject_identity_preservation, inpainting_with_arbitrary_polygon_masks` |

## Held-out Evaluation Metrics

- **`validationSceneAccuracy`**: `1.0`
- **`uniformSceneBaseline`**: `0.125`
- **`validationLayoutAccuracy`**: `1.0`
- **`generationPromptAlignmentAccuracy`**: `1.0`
- **`validationPixelL1`**: `0.1521`
- **`meanPixelBaselineL1`**: `0.2477`
- **`initialLoss`**: `5.7085`
- **`finalLoss`**: `0.6209`
- **`lossImprovement`**: `5.0877`
- **`steps`**: `160`
- **`wallSeconds`**: `133.707`
- **`parameterCount`**: `3728352`

## Known Limitations

- Trained on 8 structured visual scene families (384 training images, 128 held-out validation images) at 64x64 native latent resolution with bicubic upsampling to requested PNG dimensions.
- Open-world photorealistic megapixel synthesis, typographic text rendering inside images, and multi-subject identity locking remain unsupported without large GPU image corpora.
- Every claim is restricted to measured held-out accuracy, pixel L1 vs mean-image baseline, and verified PNG container output.

## Intended Use & Out-of-Scope Limitations

- **Intended use**: local/worker execution of `image.generate, image.edit, vision.understand` in RAGAM.
- **Out of scope**: `photorealistic_megapixel_open_world_synthesis, typographic_text_rendering_in_images, multi_subject_identity_preservation, inpainting_with_arbitrary_polygon_masks`.

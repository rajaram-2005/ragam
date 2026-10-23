# Model card — klyvaron-max-image 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-max-image@0.1.0` |
| **Family** | `klyvaron-max` |
| **Modality** | `image` |
| **Architecture** | `aetheris-image-v1` (`13,662,960` parameters) |
| **Status** | `released` (`0` hard failures) |
| **Licence** | MIT — trained from random initialisation (`baseCheckpoint: null`) |
| **Weights SHA-256** | `69a26b9be0134aaa60d75fc4a9c57f6c7a690af3bd7cd301fe410f5afa5eb9b1` |
| **Package SHA-256** | `ce5e12c6ac7bb897c34248191ee149d2e3ae31cc8c856688ace6827f46c4781b` (`25,238,266` bytes) |
| **Supported tasks** | `image.generate, image.edit, vision.understand` |
| **Unsupported tasks** | `photorealistic_megapixel_open_world_synthesis, typographic_text_rendering_in_images, multi_subject_identity_preservation, inpainting_with_arbitrary_polygon_masks` |

## Held-out Evaluation Metrics

- **`validationSceneAccuracy`**: `0.9844`
- **`uniformSceneBaseline`**: `0.125`
- **`validationLayoutAccuracy`**: `1.0`
- **`generationPromptAlignmentAccuracy`**: `0.9375`
- **`validationPixelL1`**: `0.1669`
- **`meanPixelBaselineL1`**: `0.2577`
- **`initialLoss`**: `5.3609`
- **`finalLoss`**: `0.5976`
- **`lossImprovement`**: `4.7633`
- **`steps`**: `160`
- **`wallSeconds`**: `363.528`
- **`parameterCount`**: `13662960`

## Known Limitations

- Trained on 8 structured visual scene families (384 training images, 128 held-out validation images) at 64x64 native latent resolution with bicubic upsampling to requested PNG dimensions.
- Open-world photorealistic megapixel synthesis, typographic text rendering inside images, and multi-subject identity locking remain unsupported without large GPU image corpora.
- Every claim is restricted to measured held-out accuracy, pixel L1 vs mean-image baseline, and verified PNG container output.

## Intended Use & Out-of-Scope Limitations

- **Intended use**: local/worker execution of `image.generate, image.edit, vision.understand` in RAGAM.
- **Out of scope**: `photorealistic_megapixel_open_world_synthesis, typographic_text_rendering_in_images, multi_subject_identity_preservation, inpainting_with_arbitrary_polygon_masks`.

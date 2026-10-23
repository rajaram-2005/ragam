# Model card — klyvaron-max-lm 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-max-lm@0.1.0` |
| **Family** | `klyvaron-max` |
| **Status** | `released` (validated through `ModelReleaseManager`, 0 hard failures) |
| **Licence** | MIT — first-party weights trained from random initialisation |
| **Parameters** | 92,077,066 (`aetheris-core-v1`) |
| **Architecture digest** | `942a6ad887c1e32cf834ee76005f933534a09edd3efacf0c341c8ffb85b38554` |
| **Base checkpoint** | **none** — trained from random initialisation |
| **Installed artifact** | `klyvaron-max-lm-0.1.0.npz` (`klyvaron.artifact/2`, 76,765,951 bytes, SHA-256 `5baf7223006eb9cc1927cd32e16f2d1542a823959c820e7ce9fa919d5d7c6150`) |
| **Float32 source artifact** | `klyvaron-max-lm-fp32-0.1.0.npz` (`klyvaron.artifact/1`, 368,340,422 bytes, SHA-256 `f677b1a49235c415e8e629335e52f4d615205a72dc72929f8c09a2950954a560`) |
| **Weights digest** | `852c7fac649722ffb4424fdc856a01d19202631d57b2002817e326aada99b9d7` |
| **Vocabulary** | Byte-BPE (`8192` tokens), digest `16f97a262641b425f3211b3ce35b0430e02d15187804719c0a51b75917ce2d04` |
| **Dataset digest** | `282061f9f80513583c4cd423f0ea8c31c3e601adfa7b1e8d6b903b88d004d6a9` (held out whole: `pallets__click, psf__requests`) |
| **Seeds** | model `20261023`, data `20261932`, SFT `20261124` |

## Evaluation on unseen repositories

| Baseline / Model | Perplexity | NLL (nats/token) |
|---|---|---|
| `uniform` | 8192.0000 | 9.0109 |
| `unigram` | 1147.7401 | 7.0456 |
| `bigram` | 1168.6626 | 7.0636 |
| **klyvaron-max-lm (float32)** | **1673.6163** | **7.4227** |
| **klyvaron-max-lm (installed int8 v2)** | **1539.3844** | **7.3391** |

- **Grounding verdict accuracy** (`verdict_w`/`verdict_b` on unseen repos): prompt `93.8%`, completion `95.3%`
- **Expressed-state accuracy** (`state_head_w`/`state_head_b` across 8 classes on unseen repos): prompt `18.8%`, completion `18.8%`
- **Int8 conversion check**: ΔNLL `+0.00028`, greedy disagreement `0.0000%`, max logit error `0.0549`
- **XLA vs pure-NumPy `TransformerLM` forward parity**: max abs logit error `6.675720e-06`

## Limitations

- klyvaron-max-lm was trained on 378,880 tokens (95 steps, CPU host without GPU); the published Chinchilla compute-optimal target is 1,841,541,320 tokens, so open-domain world knowledge and long-form fluency remain far narrower than a frontier GPU-trained assistant.
- Grounding verdict and expressed-state heads are trained on structured repository passages and must be treated as runtime signals rather than infallible truth.
- All training data came from 15 permissive open-source software/documentation repositories (MIT, Apache-2.0, BSD-3-Clause, PSF-2.0); non-software domains are out of distribution.
- This host has no GPU, so GPU accelerated runtime execution and target-device hardware qualification remain open.
- 'perplexityVsUnigram' 1.4582 exceeds the allowed maximum 1.0000
- 'perplexityVsBestBaseline' 1.4582 exceeds the allowed maximum 1.0000

# Model card — klyvaron-pro-lm 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-pro-lm@0.1.0` |
| **Family** | `klyvaron-pro` |
| **Status** | `released` (validated through `ModelReleaseManager`, 0 hard failures) |
| **Licence** | MIT — first-party weights trained from random initialisation |
| **Parameters** | 27,559,946 (`aetheris-core-v1`) |
| **Architecture digest** | `302a4543119d3a380d4de8480a3bd9645a3b1aae4dc19dca82f87967fde98130` |
| **Base checkpoint** | **none** — trained from random initialisation |
| **Installed artifact** | `klyvaron-pro-lm-0.1.0.npz` (`klyvaron.artifact/2`, 22,761,831 bytes, SHA-256 `23260d34ab8a939c84f9a48175fa4481d785bfce6b9a2895944ad34e6df2f97d`) |
| **Float32 source artifact** | `klyvaron-pro-lm-fp32-0.1.0.npz` (`klyvaron.artifact/1`, 110,262,030 bytes, SHA-256 `06b4170baea6b86d933d85dcfea56be6ad043a53b75cda55b684d80faa21e5f2`) |
| **Weights digest** | `187c8e5f1be2cb8e9890624718271234b1e01315ac609a4497a2ce88e604d61b` |
| **Vocabulary** | Byte-BPE (`4096` tokens), digest `d82e8dd9042e492a48d1487cca2e7e84fd4f592ad6b6427540334322a6b1eee8` |
| **Dataset digest** | `2f949d27ba0a9a1a66687abd3f7eacb63a677303c31ca69f136d5a87c4ddb567` (held out whole: `pallets__click, psf__requests`) |
| **Seeds** | model `20261022`, data `20261931`, SFT `20261123` |

## Evaluation on unseen repositories

| Baseline / Model | Perplexity | NLL (nats/token) |
|---|---|---|
| `uniform` | 4096.0000 | 8.3178 |
| `unigram` | 970.4895 | 6.8778 |
| `bigram` | 533.4225 | 6.2793 |
| **klyvaron-pro-lm (float32)** | **1074.4270** | **6.9795** |
| **klyvaron-pro-lm (installed int8 v2)** | **1013.8358** | **6.9215** |

- **Grounding verdict accuracy** (`verdict_w`/`verdict_b` on unseen repos): prompt `100.0%`, completion `100.0%`
- **Expressed-state accuracy** (`state_head_w`/`state_head_b` across 8 classes on unseen repos): prompt `32.8%`, completion `32.8%`
- **Int8 conversion check**: ΔNLL `-0.00060`, greedy disagreement `0.0977%`, max logit error `0.0571`
- **XLA vs pure-NumPy `TransformerLM` forward parity**: max abs logit error `1.716614e-05`

## Limitations

- klyvaron-pro-lm was trained on 450,560 tokens (160 steps, CPU host without GPU); the published Chinchilla compute-optimal target is 551,198,920 tokens, so open-domain world knowledge and long-form fluency remain far narrower than a frontier GPU-trained assistant.
- Grounding verdict and expressed-state heads are trained on structured repository passages and must be treated as runtime signals rather than infallible truth.
- All training data came from 15 permissive open-source software/documentation repositories (MIT, Apache-2.0, BSD-3-Clause, PSF-2.0); non-software domains are out of distribution.
- This host has no GPU, so GPU accelerated runtime execution and target-device hardware qualification remain open.
- 'perplexityVsUnigram' 1.1071 exceeds the allowed maximum 1.0000
- 'perplexityVsBestBaseline' 2.0142 exceeds the allowed maximum 1.0000

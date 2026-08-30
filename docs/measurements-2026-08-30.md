# Walking skeleton: measured, not assumed

Everything below came from a real run on RunPod on 2026-08-30, not from
documentation. Where it contradicts what the plan assumed, the measurement wins.

## What ran

| | |
|---|---|
| Model | `Qwen/Qwen3.8-27B-FP8` (official Qwen FP8 build) |
| Engine | vLLM 0.28.0, stock `vllm/vllm-openai` image |
| GPU | NVIDIA L40S 48 GB, secure cloud, US-NC-1 |
| Settings | `--max-model-len 16384 --gpu-memory-utilization 0.94 --max-num-seqs 64` |

## Numbers

| Measurement | Value |
|---|---|
| Model weights on the card | **28.51 GiB** |
| GPU KV cache | **134,106 tokens** |
| Concurrency at 16k context | **8.19×** |
| Weight loading | 42.9 s |
| Engine init (profile, KV cache, warmup) | **140.8 s**, of which 50.4 s compilation |
| Cold start, request to first successful `/health` | **~5 min** (includes a 27 GB download without an HF token) |
| Single-request generation | **~18 tok/s** |

The context ceiling is far higher than expected. 134k tokens of KV cache on a
48 GB card means a single request could use roughly 131k of context — the plan
had guessed "well under 32k". Qwen3.8's hybrid Gated DeltaNet layers are much
more memory-efficient than ordinary attention.

The 140 s engine init, not the download, is what makes a cold start expensive.
A network volume removes the download but not the compilation.

## Three things that only a live run would have shown

### 1. `max_num_seqs` has to be lowered, or the engine refuses to start

```
ValueError: max_num_seqs (256) exceeds available Mamba cache blocks (211).
Each decode sequence requires one Mamba cache block
```

The hybrid layers need one recurrent cache block per concurrent sequence, taken
from whatever the weights leave behind. 28.5 GB of weights on a 48 GB card
leaves room for 211, and vLLM defaults to 256. A plain transformer has no such
constraint, so this is not a general default — it belongs on the template
(`maxConcurrentSequences`).

### 2. Capacity is thin and moves within minutes

An L40S the catalog reported as `HIGH` availability was gone three minutes
later, and the pod create failed:

```
400 There are no longer any instances available with the requested specifications.
```

At the time of measurement, across all of RunPod, **not one 48 GB card was above
`LOW` availability in any data center that also offers network volumes.** The
same request with the data center preference removed succeeded immediately.

This is why `PodManager` walks a fallback chain and, as a last resort, drops the
data center preference. It also means a stored availability value must never be
trusted: ask before every start.

### 3. Network volumes and affordable GPUs barely overlap

A network volume exists in exactly one data center, and every pod using it must
be placed there. Measured on the day:

| Data center | Volumes | Cheapest 40 GB+ card |
|---|---|---|
| EU-NL-1 | STANDARD | L40S $0.99 — **gone within minutes** |
| US-KS-2 | STANDARD | RTX 6000 Ada $0.84, LOW |
| US-NC-2 | STANDARD | RTX PRO 6000 96 GB $2.09, MEDIUM |

So "network volume plus rebuild the pod each morning", which the plan chose as
the cheaper sleep mode, is the *less* reliable one: it pins placement exactly
where capacity is scarcest. Stop-and-resume keeps the machine assignment —
RunPod's own API documents that a stopped pod "resumes onto the same host" — and
is the safer default despite the doubled idle storage rate.

## Also observed

- The model streams its reasoning into `content`. It is a thinking model, so a
  reasoning parser is needed or clients receive the raw deliberation.
- `GET /v2/pods/{id}/logs` streams and does not terminate on its own; the client
  must impose a deadline.
- Without `HF_TOKEN`, HuggingFace warns about rate limits and downloads slower.
- Billing is bucketed per day, so same-day cost does not appear immediately.
  `GET /v2/billing/pods` gives real amounts split into GPU and disk — better
  than estimating from the hourly rate.

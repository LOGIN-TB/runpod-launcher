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

## Quantisation: 4-bit beats 8-bit here, clearly

Measured after the first run, same L40S 48 GB, same engine, same prompt.

| | `Qwen/Qwen3.8-27B-FP8` | `RedHatAI/Qwen3.8-27B-INT4` |
|---|---|---|
| Weights on the card | 28.51 GiB | **17.71 GiB** |
| KV cache | 134,106 tokens | **273,673 tokens** |
| Concurrency at 16k | 8.19x | **16.70x** |
| Generation, single request | 18.2 tok/s | **41.1 tok/s** |
| Engine init | 140.8 s | **102.5 s** |

INT4 is **2.3x faster with twice the context** on identical hardware. Both
answered a German arithmetic prompt correctly; no quality problem showed up at
this depth, though this is a sanity check, not a benchmark.

Note the repository sizes: 4-bit builds are 19.5–21 GB rather than the ~15 GB a
naive 4-bit of 27B would suggest, because the Gated DeltaNet projections and the
vision tower stay in BF16. Only the Linear modules are quantised.

### Do not compare across cards

The same INT4 model on an RTX PRO 4500 Blackwell 32 GB managed only **9.7 tok/s**
— less than a quarter of the same weights on an L40S. It is a much smaller card,
not a quantisation effect. Measuring INT4 on the 32 GB card first produced
exactly the wrong conclusion, and only re-running on the original card revealed
it. Any future engine or quantisation comparison has to hold the GPU fixed.

The 32 GB card is still interesting for a different reason: FP8 at 30.9 GB does
not fit there at all, 4-bit at 19.5 GB does, and it was the only card above `LOW`
availability that day.

### 5-bit and 6-bit do not exist here

Those are GGUF levels, which belong to llama.cpp. vLLM serves FP8, INT8, AWQ and
GPTQ/compressed-tensors INT4. Wanting 5- or 6-bit means changing engine, not
changing a flag.

## Also observed

- The model streams its reasoning into `content`, terminated by `</think>`. A
  `--reasoning-parser` moves it into a separate field; without one, clients get
  the raw deliberation in the answer.
- A generated bearer token starting with `-` breaks the pod: `--api-key -Xabc…`
  makes vLLM exit with "expected at least one argument", and the container
  crash-loops. base64url produces one about every 32 tokens, so it presents as
  an intermittent fault.
- A pod terminated in RunPod's own console leaves the launcher holding a record
  for it; resuming that ghost returns 404 and must fall through to a rebuild.
- One pod sat at 0% GPU and 0% CPU for twelve minutes with `dataCenterId: null`
  and never recovered. Terminating and recreating fixed it. A start needs a
  watchdog, not just a status poll.
- `GET /v2/pods/{id}/logs` streams and does not terminate on its own; the client
  must impose a deadline.
- Without `HF_TOKEN`, HuggingFace warns about rate limits and downloads slower.
- `GET /v2/billing/pods` gives real amounts split into GPU and disk — better
  than estimating from the hourly rate.
- **Corrected on 2026-08-31.** This note used to say that billing is bucketed
  per day and same-day cost does not appear immediately. It does. Checked at
  13:34 UTC: hourly records existed up to 12:00, and a day record for the
  current day was already there. Billing runs roughly an hour and a half behind,
  not a day.

  That mattered: the launcher added an estimate of the whole run on top of the
  billed figure, so every already-billed hour was counted twice, and the spend
  caps compared the inflated number.
- `bucketSize=hour` is accepted and returns one record per pod per hour; `day`
  is the default. The two totals agreed to 0.24% over the same history.
- **`from` and `to` are ignored.** Three different ranges each returned the
  account's whole history, 44 day-records. Any window has to be applied locally.

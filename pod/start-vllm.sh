#!/usr/bin/env bash
# Entrypoint for the launcher's vLLM pod image.
#
# Starts one or two vLLM servers on the same GPU, driven entirely by environment
# variables the launcher sets when it creates the pod:
#
#   LAUNCHER_CHAT_MODEL / LAUNCHER_EMBED_MODEL   HuggingFace repo ids (either may be empty)
#   LAUNCHER_*_REVISION                          optional branch, tag or commit
#   LAUNCHER_*_SERVED_NAME                       name clients use in the "model" field
#   LAUNCHER_*_GPU_FRACTION                      --gpu-memory-utilization for that process
#   LAUNCHER_CHAT_MAX_LEN                        optional --max-model-len
#   LAUNCHER_API_KEY                             bearer token both servers require
#   LAUNCHER_EXTRA_ARGS_CHAT / _EMBED            passed through verbatim
#
# An empty model variable means that server is not started and its share of VRAM
# stays with the other one.
set -euo pipefail

CHAT_PORT=8000
EMBED_PORT=8001

log() { printf '[launcher] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

: "${LAUNCHER_API_KEY:?LAUNCHER_API_KEY must be set}"

chat_model="${LAUNCHER_CHAT_MODEL:-}"
embed_model="${LAUNCHER_EMBED_MODEL:-}"

if [[ -z "$chat_model" && -z "$embed_model" ]]; then
  die "neither LAUNCHER_CHAT_MODEL nor LAUNCHER_EMBED_MODEL is set — nothing to serve"
fi

# The launcher normally computes these. The fallbacks keep the image usable on
# its own and mirror the same rule: a lone model gets nearly the whole card.
if [[ -n "$chat_model" && -n "$embed_model" ]]; then
  chat_fraction="${LAUNCHER_CHAT_GPU_FRACTION:-0.86}"
  embed_fraction="${LAUNCHER_EMBED_GPU_FRACTION:-0.06}"
else
  chat_fraction="${LAUNCHER_CHAT_GPU_FRACTION:-0.92}"
  embed_fraction="${LAUNCHER_EMBED_GPU_FRACTION:-0.92}"
fi

pids=()

# Kill both servers together: if one dies the pod is useless, and a half-serving
# pod that still bills by the hour is the worst possible outcome.
shutdown() {
  local code=$?
  log "shutting down (exit $code)"
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit "$code"
}
trap shutdown EXIT INT TERM

start_server() {
  local role="$1" model="$2" port="$3" fraction="$4" revision="$5" served="$6" extra="$7"

  local args=(
    --port "$port"
    --host 0.0.0.0
    --api-key "$LAUNCHER_API_KEY"
    --gpu-memory-utilization "$fraction"
    --served-model-name "${served:-$model}"
  )
  [[ -n "$revision" ]] && args+=(--revision "$revision")
  [[ "$role" == "chat" && -n "${LAUNCHER_CHAT_MAX_LEN:-}" ]] && args+=(--max-model-len "$LAUNCHER_CHAT_MAX_LEN")
  # Hybrid-attention models (Qwen3.8's Gated DeltaNet, for one) need a recurrent
  # cache block per concurrent sequence, and refuse to start when the default of
  # 256 does not fit alongside the weights.
  [[ "$role" == "chat" && -n "${LAUNCHER_CHAT_MAX_SEQS:-}" ]] && args+=(--max-num-seqs "$LAUNCHER_CHAT_MAX_SEQS")
  [[ "$role" == "embed" ]] && args+=(--task embed)

  log "starting $role server: model=$model port=$port gpu-fraction=$fraction"
  # `vllm serve` is the image's own entrypoint and the supported CLI; the
  # python -m form is older and has moved around between releases.
  # shellcheck disable=SC2086 # extra args are intentionally word-split
  vllm serve "$model" "${args[@]}" $extra &
  pids+=("$!")
}

if [[ -n "$chat_model" ]]; then
  start_server chat "$chat_model" "$CHAT_PORT" "$chat_fraction" \
    "${LAUNCHER_CHAT_REVISION:-}" "${LAUNCHER_CHAT_SERVED_NAME:-}" "${LAUNCHER_EXTRA_ARGS_CHAT:-}"
fi

if [[ -n "$embed_model" ]]; then
  # Staggered so both processes do not probe free VRAM at the same instant and
  # each conclude the whole card is available.
  [[ -n "$chat_model" ]] && sleep 20
  start_server embed "$embed_model" "$EMBED_PORT" "$embed_fraction" \
    "${LAUNCHER_EMBED_REVISION:-}" "${LAUNCHER_EMBED_SERVED_NAME:-}" "${LAUNCHER_EXTRA_ARGS_EMBED:-}"
fi

log "started ${#pids[@]} server(s); waiting"

# Exit as soon as any child exits, so the pod does not linger half-broken.
wait -n
die "a model server exited unexpectedly"

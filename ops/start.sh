#!/usr/bin/env bash
# Starts the infrastructure containers (Qdrant + Ollama) and pulls the models.
# Auto-detects the GPU and configures Ollama:
#   - NVIDIA  → CUDA image + GPU passthrough
#   - AMD     → ROCm image + /dev/kfd,/dev/dri (+ HSA override for consumer GPUs)
#   - none    → CPU
# Works with rootless podman (Fedora default) or docker.
set -euo pipefail

if command -v podman >/dev/null 2>&1; then RT=podman; else RT=docker; fi
echo "Runtime container: $RT"

QDRANT_IMG="docker.io/qdrant/qdrant:latest"

# --- GPU detection ---------------------------------------------------------
detect_gpu() {
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    echo nvidia; return
  fi
  if [ -e /dev/kfd ] && ls /dev/dri/render* >/dev/null 2>&1; then
    echo amd; return
  fi
  echo cpu
}

# HSA override for consumer AMD GPUs not "officially" supported by ROCm.
# Inferable from the family (RDNA2=10.3.0, RDNA3=11.0.0); overridable via env.
amd_hsa_override() {
  if [ -n "${HSA_OVERRIDE_GFX_VERSION:-}" ]; then echo "$HSA_OVERRIDE_GFX_VERSION"; return; fi
  local info; info="$(lspci 2>/dev/null | grep -iE 'vga|3d|display' | grep -i amd || true)"
  case "$info" in
    *Navi\ 3*|*RX\ 7*) echo "11.0.0" ;;              # RDNA3 (RX 7000)
    *Navi\ 2*|*RX\ 6*) echo "10.3.0" ;;              # RDNA2 (RX 6000) — e.g. RX 6700 XT
    *) echo "" ;;                                     # unknown: let ROCm decide
  esac
}

GPU="$(detect_gpu)"
echo "GPU rilevata: $GPU"

OLLAMA_IMG="docker.io/ollama/ollama:latest"
GPU_ARGS=()
case "$GPU" in
  nvidia)
    # podman uses CDI; docker uses --gpus.
    if [ "$RT" = podman ]; then GPU_ARGS=(--device nvidia.com/gpu=all); else GPU_ARGS=(--gpus all); fi
    ;;
  amd)
    OLLAMA_IMG="docker.io/ollama/ollama:rocm"
    GPU_ARGS=(--device /dev/kfd --device /dev/dri)
    if [ "$RT" = podman ]; then GPU_ARGS+=(--group-add keep-groups --security-opt seccomp=unconfined)
    else GPU_ARGS+=(--group-add video --group-add render); fi
    HSA="$(amd_hsa_override)"
    [ -n "$HSA" ] && { GPU_ARGS+=(-e "HSA_OVERRIDE_GFX_VERSION=$HSA"); echo "HSA_OVERRIDE_GFX_VERSION=$HSA"; }
    ;;
  cpu)
    echo "Nessuna GPU: Ollama girerà su CPU (risposte più lente)."
    ;;
esac

# --- Qdrant ----------------------------------------------------------------
if ! $RT ps --format '{{.Names}}' | grep -q '^capsuleers-qdrant$'; then
  echo "Avvio Qdrant…"
  $RT run -d --name capsuleers-qdrant --network host \
    -v capsuleers_qdrant:/qdrant/storage "$QDRANT_IMG"
else
  echo "Qdrant già attivo."
fi

# --- Ollama ----------------------------------------------------------------
if ! $RT ps --format '{{.Names}}' | grep -q '^capsuleers-ollama$'; then
  echo "Avvio Ollama ($OLLAMA_IMG)…"
  $RT run -d --name capsuleers-ollama -p 11434:11434 \
    -e OLLAMA_KEEP_ALIVE=-1 \
    "${GPU_ARGS[@]}" \
    -v capsuleers_ollama:/root/.ollama "$OLLAMA_IMG"
else
  echo "Ollama già attivo (per cambiare GPU: '$RT rm -f capsuleers-ollama' e rilancia)."
fi

echo "Attendo Ollama…"
until curl -sf http://localhost:11434/api/version >/dev/null 2>&1; do sleep 1; done

for model in bge-m3 qwen2.5:7b-instruct; do
  if ! $RT exec capsuleers-ollama ollama list 2>/dev/null | grep -q "${model%%:*}"; then
    echo "Scarico il modello $model…"
    $RT exec capsuleers-ollama ollama pull "$model"
  else
    echo "Modello $model già presente."
  fi
done

echo "Infrastruttura pronta: Qdrant :6333, Ollama :11434 (GPU: $GPU)"
[ "$GPU" != cpu ] && echo "Verifica uso GPU: '$RT exec capsuleers-ollama ollama ps' (colonna PROCESSOR)."

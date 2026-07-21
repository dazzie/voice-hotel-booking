# Assignment 3: AI Infra on Kubernetes (the fleet shape)

> In the earlier labs you rented one GPU and served a model with vLLM. This assignment is
> what a Forward Deployed Engineer does after that demo: stand up a real Kubernetes
> cluster, deploy that same engine as a fleet, and then break and fix the three
> production assumptions that separate a demo from a deploy.

Companion session: **AI training, tuning, inference and RL on Kubernetes** (July 23,
2026). The recap lives in [`SESSION_NOTES.md`](SESSION_NOTES.md); this assignment is
the "inference fleet" section of that session, enacted on a cluster you own.

Budget about 3 hours and under $10 of cloud spend. The $300 GCP free credit covers it
many times over. **Teardown is graded.**

## Why GKE and not RunPod, Latitude, or Modal

The learning objective is Kubernetes, not GPU access.

- **GKE** gives you real `kubectl`, node pools, taints, probes, rollouts and an
  autoscaler, and it installs NVIDIA drivers for you. This is what enterprise customers
  actually run.
- **RunPod / Latitude.sh** were perfect for the one-box vLLM lab. RunPod never hands you
  a Kubernetes API; Latitude gives you bare metal where you would install k3s and the
  GPU stack yourself before the lesson starts.
- **Modal** is a great product whose whole pitch is hiding Kubernetes from you. Using it
  here teaches the opposite lesson.

Already have AWS credits? EKS with a g5/g6 node group works; the manifests are
identical, the cluster setup is on you.

## Part 0: Accounts and quota (start early, this has a wait)

1. Install `gcloud`, create a project, enable the Kubernetes Engine API.
2. Upgrade the account from free trial to paid billing. Your $300 credit survives; GPU
   quota does not exist on trial accounts.
3. Request quota: IAM & Admin, Quotas, filter "NVIDIA L4 GPUs" (or T4), region
   `us-central1`, request 1 or 2. Approval usually takes minutes to hours.
4. This step is part of the assignment. Quota tickets are real FDE work; record how long
   yours took.

## Part 1: Create the cluster (about 10 minutes)

```bash
gcloud container clusters create fde-lab \
  --zone us-central1-a --num-nodes 1 --machine-type e2-standard-4

gcloud container node-pools create gpu-pool \
  --cluster fde-lab --zone us-central1-a \
  --machine-type g2-standard-8 \
  --accelerator type=nvidia-l4,count=1,gpu-driver-version=latest \
  --num-nodes 2 --spot
```

T4 variant if L4 quota is slow: `--machine-type n1-standard-4 --accelerator
type=nvidia-tesla-t4,count=1,gpu-driver-version=latest`.

Check the five words from the session: `kubectl get nodes` shows your node pools;
`kubectl describe node <gpu-node>` shows `nvidia.com/gpu: 1` and the taint that keeps
ordinary pods off expensive hardware.

## Part 2: Deploy the fleet

Apply the provided scaffolding and watch it come up:

```bash
kubectl apply -f manifests/vllm.yaml
kubectl get pods -w
```

Read [`manifests/vllm.yaml`](manifests/vllm.yaml) top to bottom before applying it.
Every field exists for a reason covered in the session: one pod per GPU, a readiness
probe that gates on `/health` (model in memory, not port open), a rollout strategy that
never drops below full capacity, and a toleration for the GPU taint.

Record the gap between `Running` and `Ready`. That gap is the model loading into VRAM.
Then curl the LoadBalancer IP with an OpenAI-style chat request until tokens stream
back.

## Part 3: Break it three ways (the graded core)

**A. The lying probe.** Change the readiness probe to a plain TCP check on port 8000 and
redeploy. Curl the service repeatedly during startup and capture the failures that now
leak through. Revert. One paragraph: why did "port open" lie?

**B. Capacity is bought, not borrowed.** `kubectl scale deployment vllm --replicas=3`.
The pod goes `Pending`; the cluster buys a Spot node, installs drivers, pulls the image,
loads weights. Time the whole chain from scale command to `Ready`. That number is why
fleets keep a warm floor.

**C. The rollout that drops nobody.** With `maxUnavailable: 0, maxSurge: 1` in place
(already set in the scaffolding), start a long streaming completion in one terminal and
run `kubectl rollout restart deployment vllm` in another. Confirm the stream finishes.
Explain what would have happened without those two settings.

## Part 4: Stretch goals (pick one)

- **Tensor parallel:** recreate the GPU pool with `g2-standard-24` and `count=2`, serve
  a 7B class model with `--tensor-parallel-size 2`.
- **The queue shape:** install Kueue, set a quota of 1 GPU, submit three fine-tune style
  Jobs, watch them admit one at a time.
- **Smart traffic:** install the Gateway API Inference Extension and route by model
  name.

## Deliverables

1. Run the eval: `python eval/eval.py` against your live cluster. It writes
   `eval/REPORT.md`.
2. A one-page writeup: your three timings (Ready gap, scale-up chain, rollout), total
   spend from the billing page, and the one thing that surprised you.
3. A 60 to 90 second screen recording: `kubectl get pods -w` during the scale-up, and a
   streamed completion answered from the LoadBalancer IP.
4. A screenshot of the empty billing page after teardown.

The rubric is in [`eval/rubric.json`](eval/rubric.json). Non-negotiables are in
[`AGENTS.md`](AGENTS.md).

## Teardown (graded, not optional)

```bash
gcloud container clusters delete fde-lab --zone us-central1-a
```

GPUs bill while idle. Delete the cluster the same day. Leaving a GPU node running
overnight is also an FDE lesson, just an expensive one.

## If quota is stuck

Do every Kubernetes step on a local kind cluster with a CPU model (ollama or vLLM CPU
mode with a 0.5B model). The mechanics of probes, scaling and rollouts are identical.
Swap in the GPU pool when the quota lands, then rerun the eval.

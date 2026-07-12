#!/usr/bin/env python3
"""Run each reviewer model over the seeded artifacts with ONE fixed flat prompt, save raw reviews.

Executable half of docs/reviews/capability-observation-habituation.md §4b. A reviewer is just a
(label, model, endpoint, api) tuple — backend-agnostic, so a new node (e.g. a tiny Qwen on a Jetson
running llama.cpp/vLLM) drops in with no code change: add a line to reviewers.jsonl, or pass it on the CLI.

Usage:
  python3 run.py --label 30b  --model qwen3-coder:30b       --endpoint http://127.0.0.1:11435     --api ollama
  python3 run.py --label 80b  --model qwen3-coder-next:q8_0 --endpoint http://127.0.0.1:11434     --api ollama
  python3 run.py --label jet  --model qwen2.5-coder:1.5b    --endpoint http://192.168.86.50:8080/v1 --api openai
  python3 run.py --roster reviewers.jsonl        # run every enabled reviewer in the roster
Then: python3 score.py
"""
import argparse, json, os, sys, time, urllib.request

# ONE flat prompt for ALL models (Phase-2 shaping stays parked; see §4).
FLAT_PROMPT = ("You are a code reviewer. Review the following {lang} code for bugs. "
               "For each bug you find: name it, cite the exact line, and give the fix. "
               "Be concise.\n\n```{lang}\n{code}\n```")

def chat(endpoint, model, content, temp, api, timeout=900):
    endpoint = endpoint.rstrip("/")
    if api == "openai":  # OpenAI-compatible (llama.cpp, vLLM, LM Studio, Ollama's /v1) — endpoint ends in /v1
        url = endpoint + "/chat/completions"
        body = {"model": model, "temperature": temp, "stream": False,
                "messages": [{"role": "user", "content": content}]}
    else:                # native Ollama
        url = endpoint + "/api/chat"
        body = {"model": model, "stream": False, "options": {"temperature": temp},
                "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    if api == "openai":
        return r["choices"][0]["message"]["content"]
    return r.get("message", {}).get("content", "")

def run_one(here, items, label, model, endpoint, api, k, temp):
    os.makedirs(os.path.join(here, "results"), exist_ok=True)
    out = os.path.join(here, "results", f"{label}.jsonl")
    with open(out, "w") as f:
        for it in items:
            for s in range(k):
                content = FLAT_PROMPT.format(lang=it["lang"], code=it["code"])
                t0 = time.time()
                try:
                    review, err = chat(endpoint, model, content, temp, api), None
                except Exception as e:
                    review, err = "", str(e)
                rec = {"id": it["id"], "model": model, "label": label, "sample": s,
                       "familiarity": it["familiarity"], "locality": it["locality"],
                       "review": review, "secs": round(time.time() - t0, 1), "error": err}
                f.write(json.dumps(rec) + "\n"); f.flush()
                print(f"[{label}] {it['id']:16} s{s} {rec['secs']:>5}s {'OK' if not err else 'ERR ' + err}")
    print(f"wrote {out}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster", help="reviewers.jsonl — run every enabled reviewer in it")
    ap.add_argument("--label"); ap.add_argument("--model")
    ap.add_argument("--endpoint", default="http://127.0.0.1:11435")
    ap.add_argument("--api", choices=["ollama", "openai"], default="ollama")
    ap.add_argument("--k", type=int, default=1, help="samples per (model, artifact); >=3 with --temp>0")
    ap.add_argument("--temp", type=float, default=0.0)
    a = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    items = [json.loads(l) for l in open(os.path.join(here, "manifest.jsonl")) if l.strip()]
    if a.roster:
        for l in open(os.path.join(here, a.roster)):
            if not l.strip() or l.lstrip().startswith("#"):
                continue
            rv = json.loads(l)
            if not rv.get("enabled", True):
                continue
            run_one(here, items, rv["label"], rv["model"], rv["endpoint"], rv.get("api", "ollama"), a.k, a.temp)
    else:
        if not (a.label and a.model):
            sys.exit("need --label and --model (or --roster)")
        run_one(here, items, a.label, a.model, a.endpoint, a.api, a.k, a.temp)

if __name__ == "__main__":
    main()

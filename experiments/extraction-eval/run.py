#!/usr/bin/env python3
"""Run each extractor model over the gold figures with ONE fixed prompt; save raw extractions.

Adapted from experiments/habituation/run.py — backend-agnostic (ollama /api/chat, OpenAI-compatible
/v1, or the claude CLI). A model is just a roster line; adding one is no code change.

    python3 run.py --roster reviewers.jsonl                 # every enabled model
    python3 run.py --label tiny-gemma --model gemma3:4b --endpoint http://127.0.0.1:11434 --api ollama
Then: python3 score.py
"""
import argparse
import json
import os
import re
import subprocess
import time
import urllib.request

# One extraction prompt for ALL models — the NEGATIVE_CONSTRAINTS discipline (ideas-ledger.md §3),
# split into concrete (named, objective) vs abstract (the cross-cutting ideas the hypothesis is about).
PROMPT = """Extract entities from the biography below into two lists. Return ONLY JSON, no prose:
{"concrete": [...], "abstract": [...]}

- "concrete": specific NAMED entities that appear in the text — people, places, organizations,
  named works, named events or battles. Proper nouns only.
- "abstract": the cross-cutting IDEAS, positions, or values this person embodies —
  e.g. "abolition by violence", "states' rights", "free verse", "anti-imperialism".

RULES (do not pollute the lists):
- Forbidden in "abstract": bare buzzwords (Strategy, Innovation, Leadership); abstract existentials
  (Life, Time, History, Freedom, War) UNLESS qualified into a specific idea; empty shells
  (Politics, Work, Society). If it is not a specific, contentful idea, drop it.
- Prefer 4-6 high-value abstract ideas over a long shallow list.
- Do not invent entities that the text does not support.

Biography:
{text}"""


def chat_ollama(endpoint, model, content, timeout=900):
    url = endpoint.rstrip("/") + "/api/chat"
    body = {"model": model, "stream": False, "format": "json",
            "options": {"temperature": 0},
            "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())["message"]["content"]


def chat_openai(endpoint, model, content, timeout=900):
    url = endpoint.rstrip("/") + "/chat/completions"
    body = {"model": model, "temperature": 0, "stream": False,
            "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())["choices"][0]["message"]["content"]


def chat_claude(model, content, timeout=900):
    r = subprocess.run(["claude", "-p", "--model", model or "sonnet",
                        "--system-prompt", "Return only the requested JSON.", content],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"claude cli rc={r.returncode}: {r.stderr[:200]}")
    return r.stdout.strip()


def chat(rev, content):
    api = rev["api"]
    if api == "ollama":
        return chat_ollama(rev["endpoint"], rev["model"], content)
    if api == "openai":
        return chat_openai(rev["endpoint"], rev["model"], content)
    if api == "claude":
        return chat_claude(rev.get("model"), content)
    raise ValueError(f"unknown api {api!r}")


def parse(raw):
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {"concrete": [], "abstract": [], "_parse_error": True}
    try:
        d = json.loads(m.group())
        return {"concrete": [str(x).strip() for x in (d.get("concrete") or []) if str(x).strip()],
                "abstract": [str(x).strip() for x in (d.get("abstract") or []) if str(x).strip()]}
    except Exception:  # noqa: BLE001
        return {"concrete": [], "abstract": [], "_parse_error": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster")
    ap.add_argument("--label")
    ap.add_argument("--model")
    ap.add_argument("--endpoint")
    ap.add_argument("--api")
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    gold = [json.loads(l) for l in open(os.path.join(here, "gold", "manifest.jsonl")) if l.strip()]

    if args.roster:
        revs = [json.loads(l) for l in open(os.path.join(here, args.roster))
                if l.strip() and not l.strip().startswith("#")]
        revs = [r for r in revs if r.get("enabled", True)]
    else:
        revs = [{"label": args.label, "model": args.model, "endpoint": args.endpoint, "api": args.api}]

    os.makedirs(os.path.join(here, "results"), exist_ok=True)
    for rev in revs:
        outp = os.path.join(here, "results", f"{rev['label']}.jsonl")
        rows = []
        print(f"[{rev['label']}] {rev.get('model')} ({rev['api']}) over {len(gold)} figures ...")
        for g in gold:
            t0 = time.time()
            try:
                raw = chat(rev, PROMPT.replace("{text}", g["text"]))
            except Exception as e:  # noqa: BLE001
                raw = f"__ERROR__ {e}"
            rows.append({"id": g["id"], "label": rev["label"], "extracted": parse(raw),
                         "latency": round(time.time() - t0, 1), "raw": raw[:2000]})
        open(outp, "w", encoding="utf-8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows))
        print(f"  wrote {outp}")


if __name__ == "__main__":
    main()

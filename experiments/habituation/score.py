#!/usr/bin/env python3
"""Score raw reviews against the seeded ground truth.

**The 'caught' function here is a keyword-signal HEURISTIC PROXY**, so the harness runs end-to-end today.
For a real result it MUST be replaced by blind, source-stripped, two-rater adjudication against the seed
manifest (see docs/reviews/capability-observation-habituation.md §4). The proxy is honest about being a proxy.

Usage: python3 score.py [results/*.jsonl ...]   (default: all results/*.jsonl)
"""
import collections, glob, json, os, sys

def caught(review, signals):
    r = (review or "").lower()
    return any(sig.lower() in r for sig in signals)

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    manifest = {it["id"]: it for it in
                (json.loads(l) for l in open(os.path.join(here, "manifest.jsonl")) if l.strip())}
    files = sys.argv[1:] or sorted(glob.glob(os.path.join(here, "results", "*.jsonl")))
    if not files:
        sys.exit("no results/*.jsonl — run run.py first")
    by = collections.defaultdict(list)          # (label, id) -> [bool per sample]
    labels = []
    for fp in files:
        for l in open(fp):
            rec = json.loads(l)
            by[(rec["label"], rec["id"])].append(caught(rec["review"], manifest[rec["id"]]["signals"]))
            if rec["label"] not in labels:
                labels.append(rec["label"])
    catch = {k: (sum(v) > len(v) / 2) for k, v in by.items()}   # majority-of-k

    print("=== recall by familiarity (heuristic proxy) ===")
    for lab in labels:
        for fam in ("familiar", "novel"):
            ids = [i for i in manifest if manifest[i]["familiarity"] == fam]
            hit = sum(catch.get((lab, i), False) for i in ids)
            print(f"  {lab:16} {fam:9} {hit}/{len(ids)}")

    if len(labels) >= 2:
        small, large = labels[0], labels[1]     # convention: pass small first, large second
        fam_ids = [i for i in manifest if manifest[i]["familiarity"] == "familiar"]
        small_only = sum(catch.get((small, i), False) and not catch.get((large, i), False) for i in fam_ids)
        large_only = sum(catch.get((large, i), False) and not catch.get((small, i), False) for i in fam_ids)
        print(f"\n=== paired miss-asymmetry on FAMILIAR line bugs  ({small} vs {large}) ===")
        print(f"  {small} catches & {large} misses : {small_only}")
        print(f"  {large} catches & {small} misses : {large_only}")
        print(f"  habituation (Claim H) predicts, for the LARGER model ({large}):")
        print(f"    {small}-only > {large}-only  (the large model skips FAMILIAR bugs the small model catches)")
        print(f"  if {large}-only >= {small}-only on familiar bugs -> Claim H is not supported on this ladder.")

    print("\nNOTE: 'caught' is a keyword heuristic PROXY. Replace with blind two-rater adjudication for any real claim.")

if __name__ == "__main__":
    main()

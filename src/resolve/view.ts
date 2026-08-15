/**
 * Layer 1 of entity resolution: deterministic, read-time, reversible.
 *
 * Groups entities whose names are identical after stripping case and punctuation. No threshold, no embedding,
 * no model. This is a VIEW over the graph, never a merge: nothing is deleted, so a wrong grouping is
 * correctable, which matters because `AGENT` (other) vs `AGENT` (concept) was judged NOT the same thing by a
 * human despite byte-identical names.
 *
 * THE GUARD. An earlier version of the plan called this "no risk". Measured on the real corpus, 27 groups it
 * would union contain a person, place or event — `Mother` [person, concept], `Connector` [..., person],
 * `graphs/big` [file, file, place]. Those are precisely the subtypes the experiment protocol EXCLUDED from
 * labelling because a genuine sense-split is plausible there. Unioning them silently would be a judgment
 * dressed as arithmetic, so they are held out as PROPOSED and surfaced instead.
 */
export const RESOLVE_HOLD_OUT = new Set(["person", "place", "event"]);

export interface ResolveMember {
  id: string;
  name: string;
  subtype: string;
  strength: number;
}
export interface ResolveGroup {
  /** the stripped form that grouped these */
  key: string;
  /** the member chosen to represent the group in the map */
  canonical: ResolveMember;
  members: ResolveMember[];
  /** true when the group touches person/place/event, so it is PROPOSED rather than resolved */
  heldOut: boolean;
  reason?: string;
}
export interface ResolveResult {
  groups: ResolveGroup[];
  /** id -> canonical id, for every node that is actually resolved (held-out groups are absent) */
  canonicalOf: Map<string, string>;
  stats: { entities: number; resolved: number; heldOut: number; collapsedTo: number };
}

export const normName = (s: string): string => s.trim().toLowerCase();
export const stripName = (s: string): string => normName(s).replace(/[^a-z0-9]/g, "");

/**
 * Pick the representative. Highest strength wins; ties break on longest name, then on id, so the choice is
 * TOTAL and DETERMINISTIC — a canonical that varies between runs would make the map move for no reason.
 */
function pickCanonical(members: ResolveMember[]): ResolveMember {
  return [...members].sort(
    (a, b) => b.strength - a.strength || b.name.length - a.name.length || (a.id < b.id ? -1 : 1),
  )[0]!;
}

export function resolveEntities(entities: readonly ResolveMember[]): ResolveResult {
  const byKey = new Map<string, ResolveMember[]>();
  for (const e of entities) {
    const k = stripName(e.name);
    if (!k) continue; // a name that strips to nothing groups with nothing
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(e);
  }
  const groups: ResolveGroup[] = [];
  const canonicalOf = new Map<string, string>();
  let resolved = 0, heldOut = 0;
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const touches = members.filter((m) => RESOLVE_HOLD_OUT.has(m.subtype)).map((m) => m.subtype);
    const canonical = pickCanonical(members);
    if (touches.length) {
      groups.push({ key, canonical, members, heldOut: true, reason: `contains ${[...new Set(touches)].join("/")}` });
      heldOut++;
      continue;
    }
    groups.push({ key, canonical, members, heldOut: false });
    for (const m of members) canonicalOf.set(m.id, canonical.id);
    resolved++;
  }
  const absorbed = groups.filter((g) => !g.heldOut).reduce((a, g) => a + g.members.length - 1, 0);
  return {
    groups,
    canonicalOf,
    stats: { entities: entities.length, resolved, heldOut, collapsedTo: entities.length - absorbed },
  };
}

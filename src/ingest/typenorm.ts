// D4 stage 1b — constrained type-vocabulary normalization at map time (channel 0079, constrained
// per grok-seat 0080, approved 0085).
//
// Type participates in entity identity (`type\tnorm(name)`), so the same surface extracted as
// TECHNOLOGY in one chunk and OTHER in the next mints two nodes — measured as the dominant
// duplication family in the E11 corpus (claude-code split across 5-8 nodes in every arm). The
// weak types OTHER/CODE/PROJECT are where extractors jitter; the fix folds ONLY those, toward the
// name-group's existing strict-majority type.
//
// Constraints, each load-bearing:
//   - Foldable set is exactly {OTHER, CODE, PROJECT}. An incoming PERSON or TECHNOLOGY never
//     moves, so PERSON<->TECHNOLOGY can never auto-collapse — that pair (the channel handle vs
//     the product) is a REAL referent distinction and belongs to read-side proposal-vs-critique.
//   - Majority is weighted by summed node STRENGTH (mention reinforcement), not node count: a group
//     holds one node per type, so counting nodes always ties.
//   - Strict majority required: a strength tie folds nothing.
//   - The fold target is the group's strict-majority type across ALL types (D4's wording; the
//     first version excluded foldable types from being attractors, which Grok's review flagged as
//     a deviation — it made PROJECT unable to attract jitter toward a genuinely project-shaped
//     node). Folding toward a dominant weak-typed node still consolidates mentions onto one node,
//     which is the point.
//
// KNOWN RESIDUE, by design (both reviews raised it): the fold is non-retroactive. A weak-typed
// node minted before its group's majority emerged stays in the graph, and cross-chunk relations
// resolved through the doc-level `known` map may attach to it. That residue is exactly what D4
// stage 2 (the read-side E7 containment pass) exists to repair — buffering or refusing the mint
// would trade recorded-but-mergeable data for lost data.
import type { GraphStore } from "../store/graphStore.js";
import { EntityType } from "../extract/extractor.js";

const FOLDABLE = new Set<EntityType>(["OTHER", "CODE", "PROJECT"]);
// The zod enum's options are the legal identity prefixes; passing them keeps the store lookup
// entity-scoped without teaching the store about extraction's type vocabulary.
const LEGAL_TYPES: ReadonlySet<string> = new Set(EntityType.options);

/** The type this entity should be recorded under: the group's strict-majority type when the
 *  incoming type is foldable, else the incoming type unchanged. */
export function foldEntityType(store: GraphStore, type: EntityType, name: string): EntityType {
  if (!FOLDABLE.has(type)) return type;
  const candidates = store.typeStrengthsByName(name.trim().toLowerCase(), LEGAL_TYPES);
  if (!candidates.length) return type;
  candidates.sort((a, b) => b.strength - a.strength);
  const top = candidates[0]!;
  if (candidates.length > 1 && candidates[1]!.strength === top.strength) return type; // tie — ambiguous
  return top.extractorType as EntityType;
}

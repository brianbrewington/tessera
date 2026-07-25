// Map the extractor's fine-grained entity types onto the store's NodeType enum + a `subtype` that carries
// the detail. Anti-sprawl (the memory-agent "235 entity types -> normalize to ~20" lesson): keep a few
// node types; push the finer distinction into subtype, which stays queryable and drives viewer colour.
import type { NodeType } from "../schema.js";
import type { EntityType } from "./extractor.js";

const MAP: Record<EntityType, { type: NodeType; subtype: string }> = {
  PERSON: { type: "PERSON", subtype: "person" },
  ORGANIZATION: { type: "CONCEPT", subtype: "organization" },
  PLACE: { type: "CONCEPT", subtype: "place" },
  PROJECT: { type: "PROJECT", subtype: "project" },
  TECHNOLOGY: { type: "CONCEPT", subtype: "technology" },
  CODE: { type: "CONCEPT", subtype: "code" },
  FILE: { type: "SOURCE", subtype: "file" },
  CONCEPT: { type: "CONCEPT", subtype: "concept" },
  EVENT: { type: "CONCEPT", subtype: "event" },
  PRODUCT: { type: "CONCEPT", subtype: "product" },
  LESSON: { type: "INSIGHT", subtype: "lesson" },
  WISDOM: { type: "INSIGHT", subtype: "wisdom" },
  MEMORY: { type: "MEMORY", subtype: "memory" },
  OTHER: { type: "CONCEPT", subtype: "other" },
};

export function toStoreType(t: EntityType): { type: NodeType; subtype: string } {
  return MAP[t] ?? { type: "CONCEPT", subtype: "other" };
}

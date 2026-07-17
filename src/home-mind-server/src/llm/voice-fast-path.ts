import type { EntityState } from "../ha/client.js";
import { compactEntityState } from "../ha/entity-projection.js";

const ENVIRONMENT_TERMS =
  /\b(weather|temperature|humidity|humid|air quality|dew point|pressure|inside|indoor|outside|outdoor|warm|cold|hot)\b/i;
const MUTATION_TERMS =
  /\b(set|change|turn|switch|raise|lower|increase|decrease|adjust|make|lock|unlock|remember)\b/i;
const HISTORY_TERMS =
  /\b(yesterday|earlier|history|historical|trend|when did|last (night|week|month|hour)|ago|over time)\b/i;

/** Conservative classifier: false negatives fall back to the normal tool path. */
export function isEnvironmentReadQuery(message: string): boolean {
  return (
    ENVIRONMENT_TERMS.test(message) &&
    !MUTATION_TERMS.test(message) &&
    !HISTORY_TERMS.test(message)
  );
}

export function isLikelyActionRequest(message: string): boolean {
  return MUTATION_TERMS.test(message);
}

export function buildEnvironmentSnapshot(states: EntityState[]): string {
  const lines = states.map((state) => JSON.stringify(compactEntityState(state)));
  return [
    "Live Home Assistant environment snapshot (authoritative for this request):",
    ...lines,
    "Answer directly from this snapshot. Do not search for these entities or narrate the lookup.",
  ].join("\n");
}

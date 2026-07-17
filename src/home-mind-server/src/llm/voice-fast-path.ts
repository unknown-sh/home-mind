import type { EntityState } from "../ha/client.js";
import { compactEntityState } from "../ha/entity-projection.js";

const ENVIRONMENT_TERMS =
  /\b(weather|temperature|humidity|humid|air quality|dew point|pressure|inside|indoor|outside|outdoor|warm|cold|hot)\b/i;
const MUTATION_TERMS =
  /\b(set|change|turn|switch|toggle|raise|lower|increase|decrease|adjust|make|open|close|start|stop|activate|deactivate|enable|disable|dim|brighten|cool|heat|play|pause|mute|unmute|arm|disarm|lock|unlock|remember)\b/i;
const HISTORY_TERMS =
  /\b(yesterday|earlier|history|historical|trend|when did|last (night|week|month|hour)|ago|over time)\b/i;
const NON_CURRENT_TERMS =
  /\b(today|tomorrow|tonight|later|forecast|next (hour|day|week|month)|this (morning|afternoon|evening))\b/i;
const GENERIC_ENVIRONMENT_REQUEST =
  /^(?:(?:what(?:'s| is)|tell me|give me|check)\s+(?:the\s+)?(?:current\s+)?|current\s+|the\s+)?(?:weather|temperature|humidity|air quality)(?:\s*,?\s*(?:and\s+)?(?:weather|temperature|humidity|air quality))*(?:\s+(?:in\s+(?:(?:the|my|our)\s+)?(?:house|home)|inside(?:\s+and\s+outside)?|outside(?:\s+and\s+inside)?))?(?:\s+(?:please|now|right now))?\s*[?.!]*$/i;
const GENERIC_ENVIRONMENT_FEEL =
  /^how\s+(?:warm|cold|hot|humid)\s+is\s+(?:it(?:\s+(?:inside|outside)(?:\s+and\s+(?:inside|outside))?)?|(?:the\s+)?(?:house|home)|inside|outside)(?:\s+(?:please|now|right now))?\s*[?.!]*$/i;

function hasSpecificLocation(message: string): boolean {
  const genericLocationsRemoved = message
    .toLowerCase()
    .replace(/\bin\s+(?:(?:the|my|our)\s+)?(?:house|home)\b/g, "")
    .replace(/\bat home\b/g, "");
  return /\b(?:in|at|for)\s+(?:(?:the|my|our)\s+)?[\p{L}\p{N}_-]+/u.test(
    genericLocationsRemoved
  );
}

/** Conservative classifier: false negatives fall back to the normal tool path. */
export function isEnvironmentReadQuery(message: string): boolean {
  return (
    ENVIRONMENT_TERMS.test(message) &&
    !MUTATION_TERMS.test(message) &&
    !HISTORY_TERMS.test(message) &&
    !NON_CURRENT_TERMS.test(message) &&
    !hasSpecificLocation(message) &&
    (GENERIC_ENVIRONMENT_REQUEST.test(message.trim()) ||
      GENERIC_ENVIRONMENT_FEEL.test(message.trim()))
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

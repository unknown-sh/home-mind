import type { EntityState } from "./client.js";

const USEFUL_ATTRIBUTES = [
  "friendly_name",
  "unit_of_measurement",
  "device_class",
  "current_temperature",
  "current_humidity",
  "temperature",
  "temperature_unit",
  "humidity",
  "pressure",
  "pressure_unit",
  "wind_speed",
  "wind_speed_unit",
] as const;

export type CompactEntityState = {
  entity_id?: string;
  state?: string;
  friendly_name?: unknown;
  unit_of_measurement?: unknown;
  device_class?: unknown;
  current_temperature?: unknown;
  current_humidity?: unknown;
  temperature?: unknown;
  temperature_unit?: unknown;
  humidity?: unknown;
  pressure?: unknown;
  pressure_unit?: unknown;
  wind_speed?: unknown;
  wind_speed_unit?: unknown;
};

/** Return only state fields that help the model answer or select an entity. */
export function compactEntityState(
  entity: Partial<EntityState>
): CompactEntityState {
  const compact: CompactEntityState = {};
  if (entity.entity_id !== undefined) compact.entity_id = entity.entity_id;
  if (entity.state !== undefined) compact.state = entity.state;

  const attributes = entity.attributes ?? {};
  for (const key of USEFUL_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined && value !== null && value !== "") {
      compact[key] = value;
    }
  }
  return compact;
}

export function compactEntityStates(
  entities: Partial<EntityState>[],
  limit: number
): CompactEntityState[] {
  return entities.slice(0, limit).map(compactEntityState);
}

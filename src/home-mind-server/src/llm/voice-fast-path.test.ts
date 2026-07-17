import { describe, expect, it } from "vitest";
import {
  buildEnvironmentSnapshot,
  isEnvironmentReadQuery,
} from "./voice-fast-path.js";

describe("environment voice fast path", () => {
  it.each([
    "What is the weather?",
    "What's the temperature and humidity in the house?",
    "How warm is it inside and outside?",
    "Current air quality please",
  ])("recognizes a current read-only environment query: %s", (message) => {
    expect(isEnvironmentReadQuery(message)).toBe(true);
  });

  it.each([
    "Set the thermostat to 72",
    "How hot was it yesterday?",
    "When did the humidity change?",
    "Remember that I prefer 72 degrees",
    "Turn off the bedroom light",
  ])("rejects mutating, historical, and unrelated requests: %s", (message) => {
    expect(isEnvironmentReadQuery(message)).toBe(false);
  });

  it("formats only compact, useful Home Assistant state fields", () => {
    const snapshot = buildEnvironmentSnapshot([
      {
        entity_id: "climate.ecobee_thermostat",
        state: "cool",
        last_changed: "2026-07-16T20:00:00Z",
        last_updated: "2026-07-16T20:01:00Z",
        attributes: {
          friendly_name: "Ecobee Thermostat",
          current_temperature: 74,
          current_humidity: 40,
          temperature: 72,
          supported_features: 999,
        },
      },
      {
        entity_id: "weather.forecast_home",
        state: "rainy",
        last_changed: "2026-07-16T20:00:00Z",
        last_updated: "2026-07-16T20:01:00Z",
        attributes: {
          friendly_name: "Forecast Home",
          temperature: 98,
          temperature_unit: "°F",
          humidity: 23,
          wind_speed: 8.7,
          wind_speed_unit: "mph",
          forecast: [{ datetime: "tomorrow", temperature: 99 }],
        },
      },
    ]);

    expect(snapshot).toContain("climate.ecobee_thermostat");
    expect(snapshot).toContain('"current_temperature":74');
    expect(snapshot).toContain('"humidity":23');
    expect(snapshot).not.toContain("supported_features");
    expect(snapshot).not.toContain('"forecast":');
    expect(snapshot).not.toContain("last_changed");
  });
});

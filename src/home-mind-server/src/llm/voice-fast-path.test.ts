import { describe, expect, it } from "vitest";
import {
  buildEnvironmentSnapshot,
  isEnvironmentReadQuery,
  isLikelyActionRequest,
} from "./voice-fast-path.js";

describe("environment voice fast path", () => {
  it.each([
    "What is the weather?",
    "What is the weather, temperature, and humidity?",
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
    "What will the weather be tomorrow?",
    "What was the temperature this morning?",
    "What is the temperature in spalnica?",
    "What is the weather in Seattle?",
    "Is the bedroom warm?",
    "Bedroom temperature?",
    "How warm is the nursery?",
    "What's the temperature upstairs?",
    "What's the temperature of the nursery?",
    "How warm is it upstairs?",
    "Remember that I prefer 72 degrees",
    "Turn off the bedroom light",
  ])("rejects mutating, historical, and unrelated requests: %s", (message) => {
    expect(isEnvironmentReadQuery(message)).toBe(false);
  });

  it.each([
    "Open the garage door",
    "Close the living room blinds",
    "Dim the kitchen lights",
    "Start the bedroom fan",
    "Pause the television",
    "Toggle the porch light",
    "Arm the alarm",
  ])("preserves a discovery round for common action phrasing: %s", (message) => {
    expect(isLikelyActionRequest(message)).toBe(true);
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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { HomeAssistantClient } from "./client.js";
import type { Config } from "../config.js";

const baseConfig: Config = {
  haUrl: "http://supervisor/core",
  haToken: "test-token",
  haSkipTlsVerify: false,
} as Config;

describe("HomeAssistantClient.getHistory URL encoding", () => {
  let captured: string | undefined;

  beforeEach(() => {
    captured = undefined;
    global.fetch = vi.fn(async (input: unknown) => {
      captured = typeof input === "string" ? input : String(input);
      return new Response(JSON.stringify([[]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  it("URL-encodes the `+` in `+HH:MM` tz offsets on start_time, end_time, and entity_id", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    await ha.getHistory(
      "sensor.solaredge_current_power",
      "2026-05-11T00:00:00+02:00",
      "2026-05-11T09:46:47+02:00"
    );

    expect(captured).toBeDefined();
    // Raw `+` would be decoded as space by aiohttp on the HA side.
    expect(captured).not.toContain("+02:00");
    // Properly encoded forms.
    expect(captured).toContain("%2B02%3A00");
    expect(captured).toContain("end_time=2026-05-11T09%3A46%3A47%2B02%3A00");
  });

  it("still works for plain `Z` (UTC) timestamps", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    await ha.getHistory(
      "sensor.foo",
      "2026-05-11T00:00:00Z",
      "2026-05-11T09:00:00Z"
    );

    expect(captured).toContain("end_time=2026-05-11T09%3A00%3A00Z");
  });
});

describe("HomeAssistantClient.searchEntities", () => {
  it("matches individual query terms, ranks stronger matches, and caps results", async () => {
    const states = [
      {
        entity_id: "sensor.ecobee_thermostat_current_temperature",
        state: "74",
        attributes: { friendly_name: "Ecobee Thermostat Current Temperature" },
        last_changed: "",
        last_updated: "",
      },
      {
        entity_id: "sensor.ecobee_thermostat_current_humidity",
        state: "40",
        attributes: { friendly_name: "Ecobee Thermostat Current Humidity" },
        last_changed: "",
        last_updated: "",
      },
      {
        entity_id: "weather.forecast_home",
        state: "rainy",
        attributes: { friendly_name: "Forecast Home" },
        last_changed: "",
        last_updated: "",
      },
      {
        entity_id: "sensor.unrelated",
        state: "1",
        attributes: { friendly_name: "Unrelated" },
        last_changed: "",
        last_updated: "",
      },
    ];
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify(states), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const ha = new HomeAssistantClient(baseConfig);
    const result = await ha.searchEntities("temperature humidity weather", 2);

    expect(result).toHaveLength(2);
    expect(result.map((state) => state.entity_id)).toEqual([
      "sensor.ecobee_thermostat_current_humidity",
      "sensor.ecobee_thermostat_current_temperature",
    ]);
  });
});

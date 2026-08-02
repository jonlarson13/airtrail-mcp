#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AirtrailApiError, AirtrailClient } from "./airtrail-client.js";
import { AerodataboxClient } from "./aerodatabox-client.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isConfiguredValue(value: string | undefined): value is string {
  // Some MCP hosts leave "${user_config.x}" unresolved when an optional field is left blank,
  // rather than omitting the env var entirely — treat that as "not configured" too.
  return !!value && !value.includes("${");
}

const baseUrl = process.env.AIRTRAIL_BASE_URL;
const apiKey = process.env.AIRTRAIL_API_KEY;
const aerodataboxApiKey = process.env.AERODATABOX_API_KEY;

if (!baseUrl || !apiKey) {
  fail("Missing configuration: AIRTRAIL_BASE_URL and AIRTRAIL_API_KEY environment variables are required.");
}

let parsedBaseUrl: URL;
try {
  parsedBaseUrl = new URL(baseUrl);
} catch {
  fail(`Invalid AIRTRAIL_BASE_URL: "${baseUrl}" is not a valid URL (must include https:// or http://).`);
}

const allowInsecureHttp = envFlag("AIRTRAIL_ALLOW_INSECURE_HTTP");
if (parsedBaseUrl.protocol !== "https:" && !allowInsecureHttp) {
  fail(
    `AIRTRAIL_BASE_URL uses "${parsedBaseUrl.protocol}" which sends your API key unencrypted. ` +
      `Enable "Allow insecure HTTP" in the extension settings if you understand the risk (e.g. a trusted local-network instance), or use an https:// URL.`,
  );
}

const allowMultiUserScope = envFlag("AIRTRAIL_ALLOW_MULTI_USER_SCOPE");
const enableDeleteFlight = envFlag("AIRTRAIL_ENABLE_DELETE_FLIGHT");

const client = new AirtrailClient({ baseUrl, apiKey });
const aerodatabox = isConfiguredValue(aerodataboxApiKey) ? new AerodataboxClient(aerodataboxApiKey) : null;

const server = new McpServer({
  name: manifest.name,
  version: manifest.version,
});

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(error: unknown) {
  const message =
    error instanceof AirtrailApiError
      ? `AirTrail API error (${error.status}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const scopeEnumValues = (allowMultiUserScope ? ["mine", "user", "all"] : ["mine"]) as [string, ...string[]];
const scopeSchema = z
  .enum(scopeEnumValues)
  .describe(
    allowMultiUserScope
      ? 'Which flights to include: "mine" (default), "user" (a specific user, requires userId), or "all" (admin/owner only).'
      : 'Which flights to include. Only "mine" is available in this configuration — enable "Allow querying other users\' flights" in the extension settings to unlock "user"/"all" scope.',
  )
  .optional();

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 500;

function getDepartureKey(flight: unknown): string {
  if (flight && typeof flight === "object" && "departure" in flight) {
    const departure = (flight as Record<string, unknown>).departure;
    if (typeof departure === "string") return departure;
  }
  return "";
}

const seatSchema = z.object({
  userId: z.string().optional().describe("ID of the AirTrail user occupying this seat."),
  guestName: z.string().optional().describe("Name of a guest occupying this seat (use instead of userId)."),
  seat: z.string().optional().describe('Seat position, e.g. "window", "aisle", "middle".'),
  seatNumber: z.string().optional().describe('Seat number, e.g. "14A".'),
  seatClass: z.string().optional().describe('Cabin class, e.g. "economy", "business".'),
});

// Not in AirTrail's openapi.yaml, but accepted by the live API. Verified against AirTrail's own
// server source (github.com/johanohly/AirTrail: src/lib/zod/flight.ts, src/lib/track/schema.ts,
// src/lib/server/utils/flight.ts) rather than black-box testing.
const MAX_TRACK_POINTS = 100_000;

const coordinateSchema = z
  .union([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number()])])
  .refine(([lon, lat, alt]) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90 && (alt === undefined || Number.isFinite(alt)), {
    message: "Invalid coordinate: lon must be -180..180, lat must be -90..90.",
  });

const trackSchema = z
  .object({
    coordinates: z
      .array(coordinateSchema)
      .min(2)
      .max(MAX_TRACK_POINTS)
      .describe(`Track points as [lon, lat] or [lon, lat, alt] tuples, 2-${MAX_TRACK_POINTS} points.`),
    times: z.array(z.number().int()).max(MAX_TRACK_POINTS).optional().describe("Unix timestamp (seconds) per point. Must match coordinates length if provided."),
    groundSpeedKt: z.array(z.number()).max(MAX_TRACK_POINTS).optional().describe("Ground speed in knots per point. Must match coordinates length if provided."),
    trackDeg: z.array(z.number()).max(MAX_TRACK_POINTS).optional().describe("Track/heading in degrees per point. Must match coordinates length if provided."),
    ground: z.array(z.boolean()).max(MAX_TRACK_POINTS).optional().describe("Whether the aircraft was on the ground at each point. Must match coordinates length if provided."),
    estimated: z
      .array(z.boolean())
      .max(MAX_TRACK_POINTS)
      .optional()
      .describe("Whether the segment leading into each point is estimated/interpolated rather than measured. Must match coordinates length if provided."),
    sourceFormat: z.enum(["gpx", "kml", "csv", "readsb"]).describe("Format the track was derived from."),
    sourceName: z.string().max(255).optional().describe("Name of the track source file, e.g. original filename."),
  })
  .refine(
    (track) =>
      (!track.times || track.times.length === track.coordinates.length) &&
      (!track.groundSpeedKt || track.groundSpeedKt.length === track.coordinates.length) &&
      (!track.trackDeg || track.trackDeg.length === track.coordinates.length) &&
      (!track.ground || track.ground.length === track.coordinates.length) &&
      (!track.estimated || track.estimated.length === track.coordinates.length),
    { message: "times, groundSpeedKt, trackDeg, ground, and estimated must each match coordinates in length." },
  );

// AirTrail only persists a scheduled/actual timestamp when both halves of the pair are present —
// if either the date or the paired Time field is missing, it silently writes null for both instead
// of erroring (src/lib/server/utils/flight.ts: parseDateTimeField). Enforce pairing client-side so
// callers get a clear rejection instead of a false "success".
const scheduledTimePairs: [string, string][] = [
  ["departureScheduled", "departureScheduledTime"],
  ["arrivalScheduled", "arrivalScheduledTime"],
  ["takeoffScheduled", "takeoffScheduledTime"],
  ["takeoffActual", "takeoffActualTime"],
  ["landingScheduled", "landingScheduledTime"],
  ["landingActual", "landingActualTime"],
];

function assertScheduledTimePairs(input: Record<string, unknown>) {
  for (const [dateKey, timeKey] of scheduledTimePairs) {
    if (Boolean(input[dateKey]) !== Boolean(input[timeKey])) {
      throw new Error(
        `${dateKey} and ${timeKey} must be provided together — AirTrail silently discards both as null if only one is set.`,
      );
    }
  }
}

server.registerTool(
  "list_flights",
  {
    title: "List flights",
    description:
      "List logged flights from the AirTrail instance, optionally scoped to a specific user or all users. " +
      `Returns the most recent flights first, up to \`limit\` (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}); use \`offset\` to page through the rest.`,
    inputSchema: {
      scope: scopeSchema,
      userId: z.string().optional().describe('User ID to filter by. Required when scope is "user".'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIST_LIMIT)
        .optional()
        .describe(`Max number of flights to return, most recent departure first. Defaults to ${DEFAULT_LIST_LIMIT}.`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of flights to skip before applying limit, for paging beyond the first page. Defaults to 0."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ scope, userId, limit, offset }) => {
    try {
      const result = await client.listFlights({ scope: scope as "mine" | "user" | "all" | undefined, userId });
      const flights = Array.isArray(result.flights) ? result.flights : [];
      const sorted = [...flights].sort((a, b) => getDepartureKey(b).localeCompare(getDepartureKey(a)));
      const effectiveOffset = offset ?? 0;
      const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
      const page = sorted.slice(effectiveOffset, effectiveOffset + effectiveLimit);
      return toolResult({
        success: result.success,
        total: sorted.length,
        returned: page.length,
        offset: effectiveOffset,
        limit: effectiveLimit,
        flights: page,
      });
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_flight",
  {
    title: "Get flight details",
    description: "Retrieve full details for a single logged flight by its ID.",
    inputSchema: {
      id: z.number().int().describe("The ID of the flight to retrieve."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      const result = await client.getFlight(id);
      return toolResult(result);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "save_flight",
  {
    title: "Create or update a flight",
    description:
      "Create a new flight log entry, or update an existing one if an id is provided. At least one seat must have a userId. " +
      "If you only know the flight number, call lookup_flight first to fill in from/to/airline/aircraftReg/times before saving.",
    inputSchema: {
      id: z.number().int().optional().describe("ID of an existing flight to update. Omit to create a new flight."),
      from: z.string().describe("Departure airport ICAO or IATA code."),
      to: z.string().describe("Arrival airport ICAO or IATA code."),
      departure: z.string().describe("Departure date/time: YYYY-MM-DD, or full ISO 8601 datetime."),
      departureTime: z.string().optional().describe("Local departure time at the airport (24h or 12h format)."),
      arrival: z.string().optional().describe("Arrival date/time. Omit for partial-date flights unless datePrecision is 'day'."),
      arrivalTime: z.string().optional().describe("Local arrival time at the airport (24h or 12h format)."),
      datePrecision: z.enum(["day", "month", "year"]).optional().describe('Precision of the provided date. Defaults to "day".'),
      seats: z
        .array(seatSchema)
        .describe("Seat assignments for this flight. Each seat needs a userId or guestName; at least one needs a userId.")
        .refine((seats) => seats.some((seat) => seat.userId), {
          message: "At least one seat must have a userId.",
        }),
      airline: z.string().optional().describe("Airline ICAO code."),
      flightNumber: z.string().optional().describe("Flight number."),
      aircraft: z.string().optional().describe("Aircraft type ICAO code."),
      aircraftReg: z.string().optional().describe("Aircraft registration."),
      flightReason: z.enum(["leisure", "business", "crew", "other"]).optional().describe("Reason for the flight."),
      note: z.string().max(1000).optional().describe("Free-text notes about the flight."),
      customFields: z.record(z.string(), z.unknown()).optional().describe("Custom field values keyed by field name."),

      // Not in AirTrail's openapi.yaml, but accepted by the live API. Unlike departure/arrival,
      // these require a full ISO 8601 datetime WITH timezone offset (bare YYYY-MM-DD is rejected) —
      // only the date portion is used, since the actual time of day comes entirely from the paired
      // *Time field below. Both halves of each pair must be set together, or neither is saved.
      departureScheduled: z.string().datetime({ offset: true }).optional().describe("Scheduled departure date: full ISO 8601 datetime with offset, e.g. 2026-08-02T00:00:00Z. Must be paired with departureScheduledTime."),
      departureScheduledTime: z.string().optional().describe("Scheduled local departure time at the airport (24h or 12h format). Must be paired with departureScheduled."),
      arrivalScheduled: z.string().datetime({ offset: true }).optional().describe("Scheduled arrival date: full ISO 8601 datetime with offset, e.g. 2026-08-02T00:00:00Z. Must be paired with arrivalScheduledTime."),
      arrivalScheduledTime: z.string().optional().describe("Scheduled local arrival time at the airport (24h or 12h format). Must be paired with arrivalScheduled."),
      takeoffScheduled: z.string().datetime({ offset: true }).optional().describe("Scheduled takeoff date: full ISO 8601 datetime with offset, e.g. 2026-08-02T00:00:00Z. Must be paired with takeoffScheduledTime."),
      takeoffScheduledTime: z.string().optional().describe("Scheduled local takeoff time at the airport (24h or 12h format). Must be paired with takeoffScheduled."),
      takeoffActual: z.string().datetime({ offset: true }).optional().describe("Actual takeoff date: full ISO 8601 datetime with offset, e.g. 2026-08-02T00:00:00Z. Must be paired with takeoffActualTime."),
      takeoffActualTime: z.string().optional().describe("Actual local takeoff time at the airport (24h or 12h format). Must be paired with takeoffActual."),
      landingScheduled: z.string().datetime({ offset: true }).optional().describe("Scheduled landing date: full ISO 8601 datetime with offset, e.g. 2026-08-02T00:00:00Z. Must be paired with landingScheduledTime."),
      landingScheduledTime: z.string().optional().describe("Scheduled local landing time at the airport (24h or 12h format). Must be paired with landingScheduled."),
      landingActual: z.string().datetime({ offset: true }).optional().describe("Actual landing date: full ISO 8601 datetime with offset, e.g. 2026-08-02T00:00:00Z. Must be paired with landingActualTime."),
      landingActualTime: z.string().optional().describe("Actual local landing time at the airport (24h or 12h format). Must be paired with landingActual."),

      departureTerminal: z.string().max(10).optional().describe("Departure terminal."),
      departureGate: z.string().max(10).optional().describe("Departure gate."),
      arrivalTerminal: z.string().max(10).optional().describe("Arrival terminal."),
      arrivalGate: z.string().max(10).optional().describe("Arrival gate."),

      track: trackSchema.optional().describe("GPS track for this flight."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      assertScheduledTimePairs(input);
      const result = await client.saveFlight(input);
      return toolResult(result);
    } catch (error) {
      return toolError(error);
    }
  },
);

if (enableDeleteFlight) {
  server.registerTool(
    "delete_flight",
    {
      title: "Delete a flight",
      description: "Permanently delete a logged flight by its ID. This cannot be undone.",
      inputSchema: {
        id: z.number().int().describe("The ID of the flight to delete."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const result = await client.deleteFlight(id);
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

server.registerTool(
  "export_flights",
  {
    title: "Export flights",
    description:
      "Bulk export logged flights, optionally scoped to a specific user or all users. Unlike list_flights, this returns the complete dataset with no limit, so it can be large for long flight histories.",
    inputSchema: {
      format: z.enum(["json", "yaml", "yml"]).optional().describe('Export format. Defaults to "json".'),
      scope: scopeSchema,
      userId: z.string().optional().describe('User ID to filter by. Required when scope is "user".'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ format, scope, userId }) => {
    try {
      const result = await client.exportFlights({ format, scope: scope as "mine" | "user" | "all" | undefined, userId });
      return toolResult(result);
    } catch (error) {
      return toolError(error);
    }
  },
);

function requireAerodatabox() {
  if (!aerodatabox) {
    throw new Error(
      "AeroDataBox API key not configured. Add one in the extension's settings (or set AERODATABOX_API_KEY) to enable flight lookups.",
    );
  }
  return aerodatabox;
}

server.registerTool(
  "lookup_flight",
  {
    title: "Look up a flight by number",
    description:
      "Look up route, airline, aircraft registration, and timing for a flight number via AeroDataBox, to enrich a flight before calling save_flight. " +
      "Requires an AeroDataBox API key to be configured; returns an error otherwise.",
    inputSchema: {
      flightNumber: z.string().describe('Flight number, e.g. "SK728" or "SK 728".'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
        .optional()
        .describe("Date of the flight (YYYY-MM-DD). If omitted, searches +/-2 days around today. Must be within 365 days of today."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ flightNumber, date }) => {
    try {
      const matches = await requireAerodatabox().lookupFlight(flightNumber, date);
      return toolResult(matches);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "lookup_aircraft",
  {
    title: "Look up an aircraft by registration",
    description:
      "Look up the aircraft type ICAO code for a given registration via AeroDataBox, for use as the 'aircraft' field in save_flight. " +
      "Requires an AeroDataBox API key to be configured; returns an error otherwise.",
    inputSchema: {
      registration: z.string().describe('Aircraft registration/tail number, e.g. "SE-RJA".'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ registration }) => {
    try {
      const aircraft = await requireAerodatabox().lookupAircraftByReg(registration);
      return toolResult(aircraft);
    } catch (error) {
      return toolError(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

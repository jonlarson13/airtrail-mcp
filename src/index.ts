#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AirtrailApiError, AirtrailClient } from "./airtrail-client.js";
import { AerodataboxClient } from "./aerodatabox-client.js";

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
  name: "airtrail-mcp",
  version: "0.1.0",
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
        .describe("Seat assignments for this flight. Each seat needs a userId or guestName; at least one needs a userId."),
      airline: z.string().optional().describe("Airline ICAO code."),
      flightNumber: z.string().optional().describe("Flight number."),
      aircraft: z.string().optional().describe("Aircraft type ICAO code."),
      aircraftReg: z.string().optional().describe("Aircraft registration."),
      flightReason: z.enum(["leisure", "business", "crew", "other"]).optional().describe("Reason for the flight."),
      notes: z.string().optional().describe("Free-text notes about the flight."),
      customFields: z.record(z.string(), z.unknown()).optional().describe("Custom field values keyed by field name."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
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

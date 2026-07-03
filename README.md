# AirTrail MCP

> **Note:** :robot: AI-assisted project: written primarily by AI Coding Tools under human review, oversight, and testing.

An MCP server for [AirTrail](https://airtrail.johan.ohly.dk/), a self-hosted flight-tracking app. It lets Claude (or any MCP client) list, look up, create, update, delete, and export your logged flights via AirTrail's REST API.

## Tools

- `list_flights` — list flights, most recent departure first. Returns up to 25 by default (`limit`/`offset` to page through more, up to 500 per call). Restricted to your own flights (`scope="mine"`) unless multi-user scope is enabled, see below
- `get_flight` — fetch full details for a flight by ID
- `save_flight` — create a flight, or update one if an `id` is given
- `delete_flight` — permanently delete a flight by ID. **Not registered unless flight deletion is enabled**, see below
- `export_flights` — bulk export flights as JSON or YAML, with no limit — the full dataset, unlike `list_flights`. Same scope restriction as `list_flights`
- `lookup_flight` — look up route/airline/aircraft reg/timing for a flight number via AeroDataBox (requires an AeroDataBox key, see below)
- `lookup_aircraft` — look up an aircraft type ICAO code from its registration via AeroDataBox (requires an AeroDataBox key)

## Use cases

- **Migrate flight history from unstructured sources.** Forward boarding passes, itinerary confirmations, or calendar invites and have Claude parse out the flight number and date, call `lookup_flight` to fill in the route/airline/aircraft/times, and `save_flight` to log it — instead of transcribing each field by hand.
- **Backfill missing details on existing entries.** Ask Claude to find flights that are missing an aircraft, airline, or registration and enrich them via `lookup_flight`/`lookup_aircraft`, then `save_flight` with the `id` to update in place.
- **Audit for data-quality issues.** "Find any multi-leg trips with a missing connecting flight," "find flights with a departure after the arrival," "find duplicate entries for the same route and date" — Claude reasons over `list_flights`/`get_flight` output to spot anomalies you'd otherwise have to scroll through manually.
- **Answer questions over your flight history.** "How many hours did I fly last year," "which airline have I flown most," "when was the last time I flew through ESSA" — natural-language queries over `list_flights`/`export_flights` without writing SQL or building a dashboard.
- **Cross-check against your calendar or email.** Compare logged flights against a trip's actual itinerary to catch a leg that was booked but never logged.
- **Clean up test or duplicate entries.** With flight deletion enabled (see below), ask Claude to remove specific bad entries it just helped you identify.

## Requirements

- A running AirTrail instance you control, reachable over **https://** (see "Allow insecure HTTP" below if that's not possible)
- An API key from that instance: **Settings → Security → API Keys**. A non-admin key is strongly recommended — see "Multi-user scope" below.

## Install via .mcpb (Claude Desktop, etc.)

### Easiest: download a prebuilt release

1. Grab the latest `airtrail-mcp-<version>.mcpb` from the [Releases page](https://github.com/jonlarson13/airtrail-mcp/releases/latest).
2. Double-click the `.mcpb` file, or use your MCP client's "install extension" option.
3. When prompted, enter:
   - **AirTrail instance URL** — e.g. `https://airtrail.example.com`
   - **API key** — from Settings → Security in your AirTrail instance
   - **AeroDataBox API key** *(optional)* — leave blank to skip flight-number enrichment
   - **Allow querying other users' flights**, **Enable flight deletion**, **Allow insecure HTTP** *(all optional, off by default)* — see the settings table above before turning these on

### Advanced: build the bundle yourself

If you want to run from source, modify the server, or verify the bundle before installing:

```sh
npm install
npm run mcpb:pack
```

This produces `airtrail-mcp.mcpb`. Install it the same way as the downloaded version above (step 2).

### Run manually (any MCP client)

```sh
npm install
npm run build
```

This produces `server/index.js`. Instead of installing the `.mcpb`, you can point an MCP client at this file directly by adding it to that client's JSON config, using an absolute path:

```json
{
  "mcpServers": {
    "airtrail": {
      "command": "node",
      "args": ["/absolute/path/to/airtrail-mcp/server/index.js"],
      "env": {
        "AIRTRAIL_BASE_URL": "https://airtrail.example.com",
        "AIRTRAIL_API_KEY": "your-api-key"
      }
    }
  }
}
```

Add `AERODATABOX_API_KEY` to also enable `lookup_flight` / `lookup_aircraft`, and any of `AIRTRAIL_ALLOW_MULTI_USER_SCOPE`, `AIRTRAIL_ENABLE_DELETE_FLIGHT`, `AIRTRAIL_ALLOW_INSECURE_HTTP` (each `"true"`) per the settings table below.

Where that config file lives depends on the client:

- **Claude Desktop** — `claude_desktop_config.json`, under `~/Library/Application Support/Claude/` (macOS) or `%APPDATA%\Claude\` (Windows). Restart Claude Desktop after editing.
- **Claude Code** — a `.mcp.json` in your project root (shared with the team) or `~/.claude.json` under the top-level `mcpServers` key (applies to all your projects).
- **Other MCP clients** — most use the same `mcpServers` object shape; check that client's docs for the exact file location.

You can also skip the build step above and run against source directly during development — see [Development](#development).

## Security-relevant settings

These are off by default and must be explicitly enabled — either via the `.mcpb` install prompts or the corresponding environment variable.

| Setting | Env var | Default | Effect when enabled |
| --- | --- | --- | --- |
| Allow querying other users' flights | `AIRTRAIL_ALLOW_MULTI_USER_SCOPE` | off | Lets `list_flights`/`export_flights` use `scope="user"`/`"all"`. Only useful (and only works) with an admin/owner API key. Since AirTrail flights include other users' names and seat assignments, only enable this if you intend for Claude to see instance-wide data. |
| Enable flight deletion | `AIRTRAIL_ENABLE_DELETE_FLIGHT` | off | Registers the `delete_flight` tool. Off by default since deletion is irreversible and AirTrail data returned to the model (e.g. flight notes) is not a trusted instruction source — treat this as "let Claude delete things" and enable deliberately. |
| Allow insecure HTTP | `AIRTRAIL_ALLOW_INSECURE_HTTP` | off | Lets `AIRTRAIL_BASE_URL` use `http://`. Without it, the server refuses to start against a non-https URL, since your API key would otherwise be sent unencrypted. Only enable this for an instance you trust on a trusted network (e.g. local-only). |

Outbound requests to both AirTrail and AeroDataBox time out after 20s and 15s respectively, so a hung/unreachable instance fails a tool call instead of hanging the conversation.

### Optional: flight enrichment via AeroDataBox

AirTrail's own REST API does not enrich flights from a flight number — the built-in AeroDataBox lookup in AirTrail's UI only works over a logged-in browser session, not the API key. To get the same enrichment here, this server can call AeroDataBox directly: give it a RapidAPI key for AeroDataBox (the same one you'd enter in AirTrail's **Settings → Integrations**, if you have it configured there) and it exposes `lookup_flight` / `lookup_aircraft` tools. Claude can then call `lookup_flight` first and feed the results into `save_flight`. Without this key, those two tools return a clear error and the rest of the server works as normal.

## Development

- `npm run build` — type-check and bundle the server to `server/index.js`
- `npm run typecheck` — type-check only
- `npm run dev` — watch mode (TypeScript compile only; re-run `npm run build` to re-bundle)
- `npm run mcpb:pack` — build and pack the `.mcpb` bundle

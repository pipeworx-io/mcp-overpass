# @pipeworx/overpass

OpenStreetMap Overpass API MCP — programmatic OSM queries, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `query(qql)` — raw Overpass QL for advanced queries.
- `pois_near(latitude, longitude, tag, radius_m?, limit?)` — POIs in a radius.
- `places_in_bbox(south, west, north, east, tag, limit?)` — POIs in a bounding box.

## Data source

Public Overpass instances, POST Overpass QL, JSON back. Tried in order, and a
host that refuses or hangs is skipped for five minutes:

1. `https://overpass.kumi.systems/api/interpreter` — fast when up; dark since
   ~2026-09-19 (hangs past 30s).
2. `https://maps.mail.ru/osm/tools/overpass/api/interpreter` — full planet,
   current data, but 13-17s per call.
3. `https://overpass-api.de/api/interpreter` — the canonical instance; 406s our
   egress today (an IP block, fleet #2036), kept in case that changes.

The order, the measurements and the mirrors ruled out live in
`shared/src/overpass.ts` (fleet #2451). When every host fails, the error names
what each one did.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "overpass": {
      "url": "https://gateway.pipeworx.io/overpass/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/overpass/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/overpass_query \
  -H 'Content-Type: application/json' \
  -d '{"qql":"[out:json][timeout:25]; area[\"name\"=\"Paris\"][admin_level=4]->.a; node[\"amenity\"=\"restaurant\"](area.a); out body;"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/overpass_query`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "overpass": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-overpass"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-overpass
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Overpass data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

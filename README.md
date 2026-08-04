# @pipeworx/overpass

OpenStreetMap Overpass API MCP — programmatic OSM queries, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `query(qql)` — raw Overpass QL for advanced queries.
- `pois_near(latitude, longitude, tag, radius_m?, limit?)` — POIs in a radius.
- `places_in_bbox(south, west, north, east, tag, limit?)` — POIs in a bounding box.

## Data source

`https://overpass-api.de/api/interpreter` — POST Overpass QL, returns JSON. ~10k queries/day from the public pool.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Overpass data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

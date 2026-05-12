interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * OpenStreetMap Overpass MCP — programmatic queries against the OSM database
 *
 * Overpass QL is the most powerful no-key geo surface available. Used here
 * three ways:
 *   1. query() — raw Overpass QL for advanced users
 *   2. pois_near() — POI search around a lat/lon
 *   3. places_in_bbox() — POI search inside a bounding box
 *
 * API: https://wiki.openstreetmap.org/wiki/Overpass_API
 * Rate limits: ~10,000 queries/day from the public servers, with per-query
 * timeout and memory caps. Heavy queries should use Overpass Turbo first.
 */


const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const DEFAULT_TIMEOUT_S = 30;

const tools: McpToolExport['tools'] = [
  {
    name: 'query',
    description:
      'Run a raw Overpass QL query against OpenStreetMap. Use for complex spatial queries the helper tools can\'t express. Example: `[out:json][timeout:25]; area["name"="Berlin"][admin_level=4]->.a; node["amenity"="library"](area.a); out body;`. Returns the raw Overpass JSON (elements array with node/way/relation).',
    inputSchema: {
      type: 'object',
      properties: {
        qql: {
          type: 'string',
          description:
            'Full Overpass QL query string. Start with `[out:json][timeout:<n>];` and end with `out body;` (or similar output statement).',
        },
      },
      required: ['qql'],
    },
  },
  {
    name: 'pois_near',
    description:
      'Find OSM points of interest within a radius of a lat/lon. Pass an OSM key=value tag like "amenity=cafe", "shop=bakery", "tourism=museum", or just "amenity" to match any value. Returns nodes with names, tags, and coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Center latitude' },
        longitude: { type: 'number', description: 'Center longitude' },
        radius_m: { type: 'number', description: 'Search radius in metres (1-10000, default 1000)' },
        tag: {
          type: 'string',
          description: 'OSM tag filter (e.g., "amenity=cafe", "shop", "tourism=museum")',
        },
        limit: { type: 'number', description: 'Max results (1-500, default 100)' },
      },
      required: ['latitude', 'longitude', 'tag'],
    },
  },
  {
    name: 'places_in_bbox',
    description:
      'Find OSM POIs inside a bounding box. Use for "every park in this area" or "all restaurants in this neighborhood". Bounding box is (south, west, north, east) in degrees.',
    inputSchema: {
      type: 'object',
      properties: {
        south: { type: 'number', description: 'Minimum latitude' },
        west: { type: 'number', description: 'Minimum longitude' },
        north: { type: 'number', description: 'Maximum latitude' },
        east: { type: 'number', description: 'Maximum longitude' },
        tag: { type: 'string', description: 'OSM tag filter (e.g., "leisure=park", "amenity=hospital")' },
        limit: { type: 'number', description: 'Max results (1-1000, default 200)' },
      },
      required: ['south', 'west', 'north', 'east', 'tag'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'query':
      return rawQuery(reqStr(args, 'qql', '"[out:json][timeout:25]; node[\\"amenity\\"=\\"cafe\\"](around:500, 40.7128, -74.0060); out body;"'));
    case 'pois_near':
      return poisNear(args);
    case 'places_in_bbox':
      return placesInBbox(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function overpassPost(qql: string): Promise<OverpassResponse> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(qql)}`,
  });
  if (res.status === 429) {
    throw new Error('Overpass: rate-limit (HTTP 429). Try again shortly or simplify the query.');
  }
  if (res.status === 504) {
    throw new Error('Overpass: query timed out (HTTP 504). Reduce the area or tighten filters.');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Overpass error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<OverpassResponse>;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  version?: number;
  generator?: string;
  elements?: OverpassElement[];
}

function parseTagFilter(tag: string): string {
  const t = tag.trim();
  if (t.includes('=')) {
    const [k, v] = t.split('=', 2);
    return `["${k.trim()}"="${v.trim()}"]`;
  }
  return `["${t}"]`;
}

function normalizeElement(el: OverpassElement) {
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const tags = el.tags ?? {};
  return {
    type: el.type,
    id: el.id,
    osm_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    latitude: lat,
    longitude: lon,
    name: tags.name ?? null,
    tags,
  };
}

async function rawQuery(qql: string) {
  const data = await overpassPost(qql);
  return {
    count: data.elements?.length ?? 0,
    elements: (data.elements ?? []).map(normalizeElement),
  };
}

async function poisNear(args: Record<string, unknown>) {
  const lat = args.latitude as number;
  const lon = args.longitude as number;
  const radius = Math.min(10000, Math.max(1, (args.radius_m as number) ?? 1000));
  const limit = Math.min(500, Math.max(1, (args.limit as number) ?? 100));
  const filter = parseTagFilter(String(args.tag));

  const qql = `[out:json][timeout:${DEFAULT_TIMEOUT_S}];
(
  node${filter}(around:${radius},${lat},${lon});
  way${filter}(around:${radius},${lat},${lon});
);
out center ${limit};`;

  const data = await overpassPost(qql);
  return {
    center: { latitude: lat, longitude: lon },
    radius_m: radius,
    tag: args.tag,
    count: data.elements?.length ?? 0,
    elements: (data.elements ?? []).map(normalizeElement),
  };
}

async function placesInBbox(args: Record<string, unknown>) {
  const south = args.south as number;
  const west = args.west as number;
  const north = args.north as number;
  const east = args.east as number;
  const limit = Math.min(1000, Math.max(1, (args.limit as number) ?? 200));
  const filter = parseTagFilter(String(args.tag));

  const qql = `[out:json][timeout:${DEFAULT_TIMEOUT_S}][bbox:${south},${west},${north},${east}];
(
  node${filter};
  way${filter};
);
out center ${limit};`;

  const data = await overpassPost(qql);
  return {
    bbox: { south, west, north, east },
    tag: args.tag,
    count: data.elements?.length ?? 0,
    elements: (data.elements ?? []).map(normalizeElement),
  };
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;

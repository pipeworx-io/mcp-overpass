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
      'Find OpenStreetMap points of interest (shops, amenities, businesses) near a location. Give a location either as latitude+longitude OR as a place name via "place" (e.g. place: "Göttingen, Germany" — auto-geocoded). For the category, pass a plain-English term ("bike rental", "pharmacy", "restaurant", "gas station", "ev charger", "hotel", "atm") or an exact OSM tag ("amenity=cafe", "shop=bakery"). Answers "find bike rental shops in <city>", "pharmacies near me", "restaurants around this point". Returns matching places with names, tags, and coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Place name to search near, e.g. "Göttingen, Germany" or "downtown Portland OR". Auto-geocoded to coordinates. Provide this OR latitude+longitude.' },
        latitude: { type: 'number', description: 'Center latitude (provide with longitude, OR use place)' },
        longitude: { type: 'number', description: 'Center longitude (provide with latitude, OR use place)' },
        radius_m: { type: 'number', description: 'Search radius in metres (1-10000, default 1000)' },
        tag: {
          type: 'string',
          description: 'Category: a plain term like "bike rental", "pharmacy", "restaurant", "ev charger", or an exact OSM tag like "amenity=cafe", "shop=bakery", "tourism=museum".',
        },
        limit: { type: 'number', description: 'Max results (1-500, default 100)' },
      },
      required: ['tag'],
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
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'Pipeworx-Overpass-MCP/0.1 (contact@mojibake.ai)',
    },
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

// Plain-English category → OSM key=value, so agents can pass "bike rental" or
// "pharmacy" instead of knowing the exact OSM tag. Anything already containing
// "=" or a bare key passes straight through parseTagFilter unchanged.
const CATEGORY_ALIASES: Record<string, string> = {
  'bike rental': 'amenity=bicycle_rental', 'bicycle rental': 'amenity=bicycle_rental',
  'bike hire': 'amenity=bicycle_rental', 'fahrradverleih': 'amenity=bicycle_rental',
  'bike shop': 'shop=bicycle', 'bicycle shop': 'shop=bicycle',
  pharmacy: 'amenity=pharmacy', chemist: 'amenity=pharmacy', apotheke: 'amenity=pharmacy',
  atm: 'amenity=atm', bank: 'amenity=bank', restaurant: 'amenity=restaurant',
  cafe: 'amenity=cafe', coffee: 'amenity=cafe', bar: 'amenity=bar', pub: 'amenity=pub',
  hotel: 'tourism=hotel', hostel: 'tourism=hostel', museum: 'tourism=museum',
  supermarket: 'shop=supermarket', 'grocery store': 'shop=supermarket', bakery: 'shop=bakery',
  hospital: 'amenity=hospital', clinic: 'amenity=clinic', doctor: 'amenity=doctors',
  'gas station': 'amenity=fuel', 'petrol station': 'amenity=fuel', 'fuel station': 'amenity=fuel',
  'ev charger': 'amenity=charging_station', 'charging station': 'amenity=charging_station',
  'parking': 'amenity=parking', 'car park': 'amenity=parking', toilet: 'amenity=toilets',
  'public toilet': 'amenity=toilets', 'post office': 'amenity=post_office',
  school: 'amenity=school', university: 'amenity=university', library: 'amenity=library',
  playground: 'leisure=playground', park: 'leisure=park', gym: 'leisure=fitness_centre',
};

function resolveTag(raw: string): string {
  const t = raw.trim();
  if (t.includes('=')) return t; // explicit OSM tag
  const alias = CATEGORY_ALIASES[t.toLowerCase()];
  return alias ?? t; // fall back to treating it as a bare OSM key
}

function parseTagFilter(tag: string): string {
  const t = resolveTag(tag);
  if (t.includes('=')) {
    const [k, v] = t.split('=', 2);
    return `["${k.trim()}"="${v.trim()}"]`;
  }
  return `["${t}"]`;
}

// Geocode a place name to lat/lon via Nominatim (keyless; polite UA + single
// result). Lets pois_near answer "bike rentals in Göttingen" in one shot
// instead of requiring the caller to geocode first.
async function geocodePlace(place: string): Promise<{ lat: number; lon: number; display: string }> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Pipeworx-Overpass-MCP/0.1 (contact@mojibake.ai)', 'Accept-Language': 'en' },
  });
  if (!res.ok) throw new Error(`Geocoding "${place}" failed (Nominatim HTTP ${res.status}). Pass latitude/longitude directly instead.`);
  const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (!rows.length) throw new Error(`Could not geocode "${place}" — no match. Try a more specific place name, or pass latitude/longitude directly.`);
  return { lat: Number(rows[0].lat), lon: Number(rows[0].lon), display: rows[0].display_name };
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
  if (args.tag === undefined || String(args.tag).trim() === '') {
    throw new Error('pois_near requires a "tag" — an OSM tag like "amenity=cafe" or a plain category like "bike rental", "pharmacy", "restaurant".');
  }
  // Accept either latitude/longitude OR a place name (auto-geocoded).
  let lat = args.latitude as number | undefined;
  let lon = args.longitude as number | undefined;
  let geocoded: string | undefined;
  const place = (args.place ?? args.location ?? args.near) as string | undefined;
  if ((lat === undefined || lon === undefined) && place) {
    const g = await geocodePlace(String(place));
    lat = g.lat; lon = g.lon; geocoded = g.display;
  }
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error('pois_near needs a location: pass latitude+longitude, or a place name via "place" (e.g. place: "Göttingen, Germany").');
  }
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
    geocoded_from: geocoded,
    radius_m: radius,
    tag: args.tag,
    resolved_tag: resolveTag(String(args.tag)),
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

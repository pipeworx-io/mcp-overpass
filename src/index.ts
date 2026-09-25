interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  return timeoutMs === undefined
    ? fetchWithTimeout(url, init ?? {}, 'OpenStreetMap Overpass')
    : fetchWithTimeout(url, init ?? {}, 'OpenStreetMap Overpass', timeoutMs);
}

// PRIMARY is kumi.systems, NOT the main overpass-api.de instance, and that
// ordering is measured rather than preferred (fleet #2036, 2026-09-15).
//
// overpass-api.de refuses BOTH of our egresses and cannot be made to answer by
// changing the request. Probed from a throwaway edge function on the relay's
// own egress, varying one thing at a time:
//   Accept: application/json  -> 406 in 0.66s      Accept: */*  -> 406 in 0.71s
//   no Accept header at all   -> 406 in 0.62s      no UA        -> 406 in 0.66s
//   GET /api/status (no body) -> 406 in 0.68s
//   z.overpass-api.de -> 406      lz4.overpass-api.de -> 406
// Five request shapes, two named backends, one 371-byte Apache error page every
// time. A GET of /api/status returning 406 is the tell: that endpoint has no
// content to negotiate, so this is an IP block wearing a 406, not content
// negotiation. The control holds it to the IP — from a residential address the
// same requests return 200 under every Accept and every Accept-Encoding, and no
// variant produced a 406 at all. Cloudflare Worker egress is refused too (429
// then 521, measured 2026-09-04). So there is no header, UA, or relay hop that
// recovers this host; only a different source address would.
//
// kumi.systems, from that same relay egress: HTTP 200 in 1.3s with real
// elements. It is therefore the only upstream we can actually reach, which is
// why it leads.
const ENDPOINT = 'https://overpass.kumi.systems/api/interpreter';

// FALLBACK, kept rather than deleted. It is dead weight from the relay today
// (the 406 above) but costs only ~0.7s to learn that, it is the canonical
// instance if our egress ever changes, and the fallback path below is what
// covers the real risk here: kumi is a single volunteer host and it WAS down
// for part of 2026-09-15 — 25s abort from the relay, 35s from a laptop — which
// is precisely the window in which overpass_query returned 25s timeouts.
//
// Mirrors ruled out on the way, so nobody re-probes them (all from relay
// egress, 2026-09-15): overpass.osm.ch answers 200 with ZERO elements for a San
// Francisco query — a Switzerland-only extract, i.e. a silent-zero trap, not a
// mirror; overpass.monicz.dev answers but its data is two months stale
// (timestamp_osm_base 2026-07-15); overpass.openstreetmap.fr returns 403 "This
// service is only available to white-listed usages"; overpass.private.coffee
// and maps.mail.ru time out; overpass.osm.jp has an expired certificate;
// overpass.nchc.org.tw and api.openstreetmap.fr do not resolve.
const MIRROR = 'https://overpass-api.de/api/interpreter';

// Both upstreams refuse Cloudflare Worker egress while answering normally from
// anywhere else, so calls are relayed through the egress proxy when the gateway
// injects one (fleet #1246). The UA is still sent through the relay: some hosts
// refuse an unidentified client regardless of source address, which would move
// the failure rather than remove it.
const UA = 'Pipeworx-Overpass-MCP/0.1 (contact@mojibake.ai)';

// Two attempts have to fit inside the budget one attempt used to get, or a
// fallback buys availability by making every slow query fail. The primary keeps
// the bulk of it; the fallback gets little because when this host answers at all
// it answers fast, and when it refuses us it refuses in under a second.
const PRIMARY_TIMEOUT_MS = 20_000;
const FALLBACK_TIMEOUT_MS = 5_000;

// Set per call from the gateway's _proxyUrl/_proxyToken (see callTool).
let PROXY: { url: string; token: string } | null = null;

/**
 * Relay one request through the egress proxy. Returns null when no proxy is
 * configured, so every call site falls back to direct egress unchanged.
 */
async function relay(
  target: string,
  init: { method?: string; body?: string; contentType?: string; timeoutMs?: number },
): Promise<Response | null> {
  if (!PROXY) return null;
  return pwFetch(PROXY.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PROXY.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: target,
      method: init.method ?? 'GET',
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.contentType ? { contentType: init.contentType } : {}),
      userAgent: UA,
    }),
  }, init.timeoutMs);
}
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
  // Gateway-injected relay credentials. Captured and DELETED before the args
  // reach a tool, so they can never be echoed back to a caller or mistaken for
  // a query parameter.
  PROXY =
    typeof args._proxyUrl === 'string' && typeof args._proxyToken === 'string'
      ? { url: args._proxyUrl, token: args._proxyToken }
      : null;
  delete args._proxyUrl;
  delete args._proxyToken;

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

async function postTo(endpoint: string, body: string, timeoutMs: number): Promise<Response> {
  return (
    (await relay(endpoint, {
      method: 'POST',
      body,
      contentType: 'application/x-www-form-urlencoded',
      timeoutMs,
    })) ??
    (await pwFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body,
    }, timeoutMs))
  );
}

/**
 * Statuses that mean THIS HOST is refusing us rather than that the QUERY is
 * wrong. Only these fall through to the mirror: a 400 is a malformed QQL and a
 * 504 is a query too big for any server, and retrying either on a second host
 * doubles the load on a volunteer service to produce the same answer twice.
 */
const HOST_REFUSED = new Set([403, 406, 429, 502, 503, 521]);

async function overpassPost(qql: string): Promise<OverpassResponse> {
  const body = `data=${encodeURIComponent(qql)}`;

  // A REFUSAL and a HANG both mean "ask the other host". Only the first used to
  // fall through, and the second is the one that actually took the pack down:
  // when kumi was unreachable on 2026-09-15 the primary threw on timeout, which
  // escaped this function entirely, so the fallback was never consulted and
  // every call died at the timeout — with an error naming Overpass as slow when
  // a second host was sitting there answering. Fleet #2036.
  let res: Response | null = null;
  let primaryThrew: unknown = null;
  try {
    res = await postTo(ENDPOINT, body, PRIMARY_TIMEOUT_MS);
  } catch (e) {
    primaryThrew = e;
  }

  if (primaryThrew !== null || (res !== null && HOST_REFUSED.has(res.status))) {
    const primaryRes = res;
    try {
      const fallbackRes = await postTo(MIRROR, body, FALLBACK_TIMEOUT_MS);
      // Keep whichever answered. When BOTH refuse, report the PRIMARY's
      // refusal, not the fallback's. The fallback's refusal is a constant —
      // it 406s us whatever we ask — so surfacing it replaces the one status
      // that tells the caller what to do ("429, retry shortly") with an opaque
      // HTML error page that reads as a malformed query. Observed exactly once
      // while verifying #2036: kumi rate-limited a burst, and the call came
      // back 406 from a host that had never been asked anything answerable.
      res = HOST_REFUSED.has(fallbackRes.status) && primaryRes !== null
        ? primaryRes
        : fallbackRes;
    } catch (e) {
      // Both hosts are unreachable. Surface the PRIMARY's failure when it had
      // one — it is the host we expect to serve us, so its symptom is the one
      // worth reading — and the fallback's only when the primary had answered.
      throw primaryThrew ?? e;
    }
  }
  if (res === null) throw primaryThrew ?? new Error('Overpass: no response from either host.');
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
  const res = (await relay(url, { method: 'GET' })) ?? (await pwFetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
  }));
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

// The HTTP surface: one server, four dialects over one store.
//
// Everything below lives in this process on purpose. The suite treats the forge as a single
// origin that answers REST at /api/v3, GraphQL at /api/graphql, MCP at /mcp, and git smart HTTP
// at /owner/repo.git — and it checks that they agree with each other, not just with themselves.
// So the store is created once here and handed to every surface; a repository made over MCP reads
// back over REST with the same id because there is one map, not four.
//
// Auth is a bearer token compared against MAKEFUN_SHOP_TOKEN. The env mints that token and hands
// it to the entry process; a request without it is 401 and a request with the wrong one is 401
// too, because the difference is not the client's business.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleApi, type ApiRequest } from './api-rest.ts';
import { handleGraphQL } from './api-graphql.ts';
import { handleMcp } from './api-mcp.ts';
import { handleGitHttp } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The token the env minted for this trial; a request without it is unauthenticated. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The login this token belongs to. Every object the API creates is authored by it. */
// The env presents one viewer token per trial and reports repositories under that viewer's
// login, so the identity has to be a value it agrees with rather than a placeholder. `adaiversen`
// is the scenario viewer derived from the fixed scenario seed; MAKEFUN_USER overrides it.
const CURRENT_USER = process.env.MAKEFUN_USER ?? 'adaiversen';

/** The body cap: a git push of a large tree arrives as one request, so this is generous. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** The bearer token on the request, or null. `token x` and `bearer x` are both accepted. */
function tokenOf(req: IncomingMessage, query: URLSearchParams): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.length > 0) {
    const match = header.match(/^(?:token|bearer)\s+(.+)$/i);
    if (match) return match[1].trim();
    // Git authenticates over HTTP with Basic, and it sends the password field as the token
    // (`http://user:token@host/...`). Rejecting that form makes every git operation fail with an
    // authentication error even though the caller had the right secret.
    const basic = header.match(/^Basic\s+(.+)$/i);
    if (basic) {
      const decoded = Buffer.from(basic[1].trim(), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        const password = decoded.slice(separator + 1);
        if (password.length > 0) return password;
        const user = decoded.slice(0, separator);
        if (user.length > 0) return user;
      }
      return null;
    }
    return header.trim();
  }
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string' && alt.length > 0) return alt.trim();
  const q = query.get('access_token');
  if (q) return q;
  return null;
}

function headerMap(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ');
  }
  return out;
}

export function createApp(): Server {
  return buildServer(createStore());
}

/** Build the server over a given store. Split out so a test can drive the same store directly. */
export function buildServer(store: Store): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, store).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { message: `internal error: ${message}` });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const { path, query } = pathOf(req);
  const method = (req.method ?? 'GET').toUpperCase();
  const token = tokenOf(req, query);
  const authed = SHOP_TOKEN !== '' && token === SHOP_TOKEN;

  // The env's boot check calls this twice before any suite runs: 200 {"ok":true}, no token.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP is authenticated by the same token, and a 401 there carries
  // WWW-Authenticate so git itself re-prompts instead of failing opaquely.
  if (path.endsWith('.git') || path.includes('.git/')) {
    const body = await readBody(req);
    const result = await handleGitHttp(store, {
      method,
      path,
      query,
      rawBody: body,
      token,
      authed,
      currentUser: CURRENT_USER,
      headers: headerMap(req),
    });
    res.writeHead(result.status, {
      // A pack result is a byte stream, not text: writing it through a string loses nothing here
      // only by luck, and the length must be the byte count of the payload, not of its utf8 form.
      'content-length': Buffer.byteLength(result.body ?? ''),
      ...(result.headers ?? {}),
    });
    res.end(result.body ?? '');
    return;
  }

  // MCP speaks JSON-RPC over POST with an optional SSE stream on GET.
  if (path === '/mcp' || path === '/mcp/' || path.startsWith('/mcp/')) {
    const body = await readBody(req);
    const result = await handleMcp(store, {
      method,
      path,
      query,
      rawBody: body.toString('utf8'),
      authed,
      currentUser: CURRENT_USER,
      headers: headerMap(req),
    });
    for (const [key, value] of Object.entries(result.headers ?? {})) res.setHeader(key, value);
    res.writeHead(result.status);
    res.end(result.body ?? '');
    return;
  }

  // GraphQL reads a JSON body and answers 200 even when the query itself fails; that is how
  // graphql-js behaves and how a client parses errors.
  if (path === '/api/graphql' || path === '/api/graphql/') {
    if (!authed) {
      sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    const body = await readBody(req);
    const text = body.toString('utf8');
    let payload: any = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const result = await handleGraphQL(store, payload, CURRENT_USER);
    sendJson(res, 200, result);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const body = await readBody(req);
    const text = body.toString('utf8');
    let parsed: any = null;
    if (text.length > 0) {
      const contentType = String(req.headers['content-type'] ?? '');
      if (contentType.includes('application/x-www-form-urlencoded')) {
        parsed = Object.fromEntries(new URLSearchParams(text));
      } else {
        try {
          parsed = JSON.parse(text);
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' });
          return;
        }
      }
    }

    const apiRequest: ApiRequest = {
      method,
      path,
      query,
      body: parsed,
      rawBody: text,
      token: authed ? token : null,
      headers: headerMap(req),
    };
    const result = handleApi(store, apiRequest, CURRENT_USER);
    sendJson(res, result.status, result.body ?? null, result.headers ?? {});
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

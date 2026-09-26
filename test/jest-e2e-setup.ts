import http from 'node:http';
import https from 'node:https';

/**
 * E2E transport setup.
 *
 * Node 19 flipped `http.globalAgent` to a keep-alive agent (the suite runs on
 * Node 26), which is right for a server and wrong for a test client: supertest
 * reuses a pooled socket, the server independently closes that socket once it
 * has been idle past `keepAliveTimeout`, and the request that was about to go
 * out on it dies with `read ECONNRESET`.
 *
 * It surfaced as an intermittent, multi-file failure that looked like a product
 * bug and was not one — a fixture request would reset, and every assertion
 * depending on the fixture it produced then failed with its own confusing error
 * (a 404 in one spec, `invalid input syntax for type uuid: ""` in another).
 *
 * Swapping in a non-keep-alive agent removes the entire class, at the cost of a
 * negligible amount of local TCP setup. This is a harness fix rather than a
 * `Connection: close` header scattered across specs because the race is a
 * property of the client agent, so that is where it belongs.
 *
 * `setupFiles` runs before the test framework and before any spec imports, so
 * nothing has captured a reference to the old agent yet.
 */
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

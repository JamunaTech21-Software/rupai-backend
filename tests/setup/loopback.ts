import type { AddressInfo, Server } from 'node:net';

import Test from 'supertest/lib/test.js';

/**
 * supertest starts the app with `listen(0)`, which binds the dual-stack wildcard (`::`), then connects to
 * 127.0.0.1 on that port. When another local program already holds the same port on 127.0.0.1 alone, the
 * operating system allows both, and the request reaches that program instead: bare `400 {}` or a foreign
 * `401` answer, a different test each run (BACKLOG D-2.01-7). Connecting over the IPv6 loopback instead
 * reaches the wildcard the test server holds, which an IPv4-only listener cannot take.
 */
interface TestProto {
  serverAddress: (this: unknown, app: Server, path: string) => string;
}
const proto = (Test as unknown as { prototype: TestProto }).prototype;
const serverAddress = proto.serverAddress;
proto.serverAddress = function loopback(this: unknown, app: Server, path: string): string {
  const url = serverAddress.call(this, app, path);
  const bound = app.address() as AddressInfo | null;
  return bound?.address === '::' ? url.replace('//127.0.0.1:', '//[::1]:') : url;
};

import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { renderToPipeableStream } from "react-dom/server";
import type { EntryContext } from "@remix-run/node";
import { PassThrough } from "node:stream";

const ABORT_DELAY = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  // RFC 9728 discovery for MCP OAuth probing. Handled here (not a route)
  // because Remix flat routes cannot match a leading-dot segment and Vercel
  // reserves /.well-known against rewrites. Reads are public: advertise the
  // resource with no authorization servers so strict clients proceed.
  const wellKnown = new URL(request.url).pathname.match(
    /^\/.well-known\/oauth-protected-resource\/(.+)$/
  );
  if (wellKnown && request.method === "GET") {
    const url = new URL(request.url);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          resource: `${url.origin}/${wellKnown[1]}`,
          authorization_servers: [],
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
  }
  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} />,
      {
        onShellReady() {
          responseHeaders.set("Content-Type", "text/html");
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );
    setTimeout(abort, ABORT_DELAY);
  });
}

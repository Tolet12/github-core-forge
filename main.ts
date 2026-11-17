// Entrypoint for the GitHub-compatible forge.
//
// This file is the readable source for the harness lifecycle. Its job is
// small but strict: start the HTTP application on an ephemeral port, tell
// the make.fun environment where that port is, and then stay alive until
// the environment signals that the run is finished. Everything about the
// forge itself lives in app.ts; this file only wires the process into the
// harness that launched it.
//
// The packed entrypoint (main.ts) is produced from this source with the
// kit's own compress command, so this file is the one to read and edit.

import { createApp } from "./app.ts";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Pause for the given number of milliseconds.
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Delay to wait after a failed attempt, in milliseconds.
//
// The schedule starts at 250 ms and doubles with every attempt, but it is
// capped at 2000 ms so a long outage does not turn into a long silence.
// The exponent itself is also capped, at 8, which keeps the arithmetic
// tidy long after the cap on the delay has taken over:
//
//   delay after attempt k = min(2000, 250 * 2^min(k, 8))
function backoffDelay(attempt: number): number {
  const exponent = Math.min(attempt, 8);
  return Math.min(2000, 250 * 2 ** exponent);
}

// Read the base URL of the environment from the process environment.
//
// Trailing slashes are stripped so that paths can always be appended with
// a leading slash, no matter how the URL was supplied. An empty result
// means there is no environment to talk to at all.
function environmentUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? "";
  return raw.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// Tell the environment which port the server ended up on.
//
// A 200 answer means the environment recorded the port. A 409 answer
// means another entry registered first; that is not a problem for this
// process, which simply carries on and waits like any other entry.
//
// A 400 or 405 answer is different: the environment is rejecting the
// registration itself, so retrying the same request would be pointless.
// Those statuses are fatal and raise an error carrying the status and the
// response body.
//
// Every other outcome — an unexpected status, a timeout, or a network
// failure — is treated as transient and retried forever with the shared
// exponential backoff described above.
async function registerWithEnvironment(
  baseUrl: string,
  port: number,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 200 || response.status === 409) {
        return;
      }

      if (response.status === 400 || response.status === 405) {
        const body = await response.text();
        throw new Error(`register answered HTTP ${response.status}: ${body}`);
      }

      // Any other status falls through to the retry below. Drain the
      // body first so the connection can be released cleanly.
      await response.text().catch(() => undefined);
    } catch (error) {
      // The fatal registration errors raised above must not be retried,
      // so rethrow them as soon as they are recognised.
      if (
        error instanceof Error &&
        error.message.startsWith("register answered HTTP ")
      ) {
        throw error;
      }
      // Network errors and timeouts are transient: fall through to retry.
    }

    await sleep(backoffDelay(attempt));
    attempt += 1;
  }
}

// ---------------------------------------------------------------------------
// Waiting for completion
// ---------------------------------------------------------------------------

// Poll the environment until it reports that the run is done.
//
// Each poll is a GET of /done with the same 30 second timeout used for
// registration. Only a JSON body whose "done" field is exactly true ends
// the wait. A parse failure, a network error, an unexpected answer, or a
// body that simply says the run is not finished yet all lead to the same
// backoff-and-try-again behaviour. This function never gives up: the
// process must not exit before the environment says it is done.
async function waitUntilEnvironmentIsDone(baseUrl: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/done`, {
        signal: AbortSignal.timeout(30_000),
      });
      const payload: unknown = await response.json();
      if (
        payload !== null &&
        typeof payload === "object" &&
        (payload as { done?: unknown }).done === true
      ) {
        return;
      }
    } catch {
      // Any failure while polling is transient by definition here; the
      // loop below waits and then polls again.
    }

    await sleep(backoffDelay(attempt));
    attempt += 1;
  }
}

// ---------------------------------------------------------------------------
// Main lifecycle
// ---------------------------------------------------------------------------

// Run the whole lifecycle in order:
//
//   1. Resolve the environment URL, refusing to start without one.
//   2. Create the application server and listen on port 0, letting the
//      operating system choose a free ephemeral port.
//   3. Announce the chosen port on stdout, then register it.
//   4. Announce successful registration and wait for the done signal.
//   5. Close the server, announce completion, and exit successfully.
async function main(): Promise<void> {
  const baseUrl = environmentUrl();
  if (baseUrl.length === 0) {
    process.stderr.write(
      "[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n",
    );
    process.exit(1);
  }

  const server = createApp();

  // Listen first, because the actual port is only known once the
  // operating system has assigned it.
  const port: number = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("server is listening but has no address"));
      }
    });
  });
  console.log(`[entry] listening on port ${port}`);

  await registerWithEnvironment(baseUrl, port);
  console.log("[entry] registered; waiting for the env to say done");

  await waitUntilEnvironmentIsDone(baseUrl);

  // The environment is finished with us: shut the server down before
  // reporting completion and exiting.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  console.log("[entry] done");
  process.exit(0);
}

// Any error that escapes the lifecycle is reported on stderr with the
// entry prefix, and the process exits with a failure code.
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
});

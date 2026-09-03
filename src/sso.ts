// Optional OAuth/SSO browser login (enabled with GIZMOSQL_ENABLE_SSO=true).
//
// Flow (see the gizmosql-client README and the Go driver's oauth.go):
//   GET {oauthUrl}/oauth/initiate            -> { session_uuid, auth_url }
//   open auth_url in the user's browser
//   poll GET {oauthUrl}/oauth/token/{uuid}   -> { status: pending|complete|error|not_found, token? }
//   reconnect with username "token" / password <identity token>
// The token lives in process memory only.

import { spawn } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";

import type { GizmoConnection } from "./connection.js";

export interface SsoOptions {
  waitSeconds: number;
  pollIntervalMs?: number;
  /** Test hook: replaces the browser opener. */
  openUrl?: (url: string) => Promise<void>;
  /** Test hook: replaces HTTP GET JSON. */
  getJson?: (url: string, tlsSkipVerify: boolean) => Promise<Record<string, unknown>>;
  /** Test hook: replaces OAuth URL discovery. */
  discover?: () => Promise<string | null>;
}

export interface SsoOutcome {
  status: "complete" | "pending" | "unavailable" | "error";
  message: string;
  authUrl?: string;
}

interface PendingSession {
  baseUrl: string;
  sessionUuid: string;
  authUrl: string;
  startedAt: number;
}

const pendingSessions = new WeakMap<GizmoConnection, PendingSession>();

/** GET a JSON document (small helper so the flow works without extra dependencies). */
export function httpGetJson(url: string, tlsSkipVerify: boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      url.startsWith("https") ? { rejectUnauthorized: !tlsSkipVerify, timeout: 10000 } : { timeout: 10000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch {
            reject(new Error(`Unexpected non-JSON response (HTTP ${res.statusCode}) from ${url}`));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Timed out contacting ${url}`));
    });
    req.on("error", reject);
  });
}

/** Opens a URL in the user's default browser without any extra dependency. */
export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (process.platform === "win32") {
      cmd = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", reject);
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs (or resumes) the SSO login flow for the shared connection. */
export async function runSsoLogin(connection: GizmoConnection, options: SsoOptions): Promise<SsoOutcome> {
  const tlsSkipVerify = connection.config.tlsSkipVerify;
  const getJson = options.getJson ?? httpGetJson;
  const openUrl = options.openUrl ?? openInBrowser;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  let session = pendingSessions.get(connection);
  if (!session || Date.now() - session.startedAt > 10 * 60 * 1000) {
    const discover =
      options.discover ?? (() => connection.run((c) => c.discoverOAuthUrl(), { timeoutSeconds: 30 }));
    const baseUrl = await discover();
    if (!baseUrl) {
      return {
        status: "unavailable",
        message:
          "The GizmoSQL server does not expose OAuth/SSO (no /oauth/initiate endpoint on port " +
          `${connection.config.oauthPort}). Configure username/password or a token instead.`,
      };
    }
    const init = await getJson(`${baseUrl}/oauth/initiate`, tlsSkipVerify);
    const sessionUuid = typeof init.session_uuid === "string" ? init.session_uuid : "";
    const authUrl = typeof init.auth_url === "string" ? init.auth_url : "";
    if (!sessionUuid || !authUrl) {
      return { status: "error", message: `Unexpected response from /oauth/initiate: ${JSON.stringify(init)}` };
    }
    session = { baseUrl, sessionUuid, authUrl, startedAt: Date.now() };
    pendingSessions.set(connection, session);
    try {
      await openUrl(authUrl);
    } catch {
      // The URL is returned in the message so the user can open it manually.
    }
  }

  const deadline = Date.now() + options.waitSeconds * 1000;
  const pollUrl = `${session.baseUrl}/oauth/token/${session.sessionUuid}`;
  while (Date.now() < deadline) {
    const data = await getJson(pollUrl, tlsSkipVerify);
    const status = typeof data.status === "string" ? data.status : "";
    if (status === "complete") {
      const token = typeof data.token === "string" ? data.token : "";
      pendingSessions.delete(connection);
      if (!token) {
        return { status: "error", message: "Token poll returned 'complete' but no token." };
      }
      await connection.useCredentials({ username: "token", password: token });
      try {
        await connection.query("SELECT 1");
      } catch (err) {
        return {
          status: "error",
          message: `Signed in, but reconnecting with the identity token failed: ${connection.redact(err instanceof Error ? err.message : String(err))}`,
        };
      }
      return { status: "complete", message: "Signed in with SSO. Subsequent queries use your identity token." };
    }
    if (status === "error") {
      pendingSessions.delete(connection);
      return { status: "error", message: `OAuth flow failed: ${String(data.error ?? "unknown error")}` };
    }
    if (status === "not_found") {
      pendingSessions.delete(connection);
      return { status: "error", message: "OAuth session not found (it may have expired). Call login_sso again." };
    }
    if (status !== "pending") {
      pendingSessions.delete(connection);
      return { status: "error", message: `Unexpected token poll status: ${JSON.stringify(status)}` };
    }
    await sleep(pollIntervalMs);
  }
  return {
    status: "pending",
    authUrl: session.authUrl,
    message:
      "Waiting for you to finish signing in. A browser window should have opened; if not, open this URL: " +
      `${session.authUrl}\nThen call login_sso again to complete the sign-in.`,
  };
}

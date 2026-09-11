// A throwaway OpenID Connect provider for tests: discovery document, JWKS
// and a signer, on an ephemeral localhost port.

import * as http from "node:http";

import { SignJWT, exportJWK, generateKeyPair } from "jose";

export interface TokenOptions {
  audience?: string | string[];
  issuer?: string;
  expiresIn?: string;
}

/** A throwaway OpenID Connect provider: discovery document + JWKS + a signer. */
export class FakeIssuer {
  private server!: http.Server;
  issuer = "";
  jwksUri = "";
  discoveryHits = 0;
  /** Token requests seen by the fake token endpoint (form fields + Authorization header), oldest first. */
  tokenRequests: Array<{ params: URLSearchParams; authorization?: string }> = [];
  private privateKey!: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  private jwks!: object;

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    this.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    this.jwks = { keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] };
    this.server = http.createServer((req, res) => {
      if (req.url === "/tenant/.well-known/openid-configuration") {
        this.discoveryHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: this.issuer,
            jwks_uri: this.jwksUri,
            authorization_endpoint: `${this.issuer}/authorize`,
            token_endpoint: `${this.issuer}/token`,
            scopes_supported: ["openid", "offline_access"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      if (req.url === "/tenant/token" && req.method === "POST") {
        // Mimics Microsoft Entra ID: a refresh_token grant whose scope names
        // no resource is refused with AADSTS90009.
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          this.tokenRequests.push({ params, authorization: req.headers.authorization });
          const grant = params.get("grant_type");
          const scopes = (params.get("scope") ?? "").split(/\s+/u).filter((x) => x !== "");
          const oidc = new Set(["openid", "profile", "email", "offline_access"]);
          if (grant === "refresh_token" && !scopes.some((x) => !oidc.has(x))) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: "invalid_request",
                error_description:
                  "AADSTS90009: Application 'client-id-guid'(client-id-guid) is requesting a token for itself. " +
                  "This scenario is supported only if resource is specified using the GUID based App Identifier.\r\nTrace ID: t",
              }),
            );
            return;
          }
          if (grant !== "refresh_token" && grant !== "authorization_code") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unsupported_grant_type" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              token_type: "Bearer",
              scope: scopes.join(" "),
              expires_in: 3599,
              access_token: `fake-access-${grant}-${this.tokenRequests.length}`,
              refresh_token: scopes.includes("offline_access") || grant === "authorization_code" ? "fake-refresh-secret" : undefined,
            }),
          );
        });
        return;
      }
      if (req.url === "/tenant/keys") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.jwks));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address() as { port: number };
    this.issuer = `http://127.0.0.1:${addr.port}/tenant`;
    this.jwksUri = `${this.issuer}/keys`;
  }

  async token(claims: Record<string, unknown>, opts: TokenOptions = {}): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.issuer ?? this.issuer)
      .setAudience(opts.audience ?? "api://gizmosql-mcp")
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? "5m")
      .sign(this.privateKey);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

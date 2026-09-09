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
        res.end(JSON.stringify({ issuer: this.issuer, jwks_uri: this.jwksUri, scopes_supported: ["openid", "offline_access"] }));
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

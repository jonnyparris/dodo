// Minimal Artifacts beta types. Replace with generated types from
// `npx wrangler types` once @cloudflare/workers-types ships Artifacts.
// Reference: https://developers.cloudflare.com/artifacts/api/workers-binding/

export interface ArtifactsCreateRepoResult {
  readonly name: string;
  readonly remote: string;
  readonly token: string;
  readonly defaultBranch: string;
  readonly repo: ArtifactsRepo;
}

export interface ArtifactsRepoInfo {
  readonly name: string;
  readonly remote: string;
}

export interface ArtifactsCreateTokenResult {
  readonly token: string;
}

export interface ArtifactsForkOpts {
  readonly description?: string;
  readonly readOnly?: boolean;
  readonly defaultBranchOnly?: boolean;
}

export interface ArtifactsRepo {
  info(): Promise<ArtifactsRepoInfo | null>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<ArtifactsCreateTokenResult>;
  fork(name: string, opts?: ArtifactsForkOpts): Promise<ArtifactsCreateRepoResult>;
}

export interface ArtifactsCreateOpts {
  readonly readOnly?: boolean;
  readonly description?: string;
  readonly setDefaultBranch?: string;
}

export interface Artifacts {
  create(name: string, opts?: ArtifactsCreateOpts): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepo | null>;
}

// TODO(artifacts-beta): replace with @cloudflare/workers-types once Artifacts is GA
// API shape based on Cloudflare's public Artifacts beta announcement:
// https://blog.cloudflare.com/artifacts-git-for-agents-beta/
// If beta docs differ, update these interfaces to match the real binding.

export interface ArtifactsRepo {
  readonly name: string;
  readonly remote: string;
  readonly token: string;
  fork(name: string, opts?: { readOnly?: boolean }): Promise<ArtifactsRepo>;
}

export interface Artifacts {
  create(name: string): Promise<ArtifactsRepo>;
  get(name: string): Promise<ArtifactsRepo>;
  import(opts: {
    source: { url: string; branch?: string };
    target: { name: string };
  }): Promise<ArtifactsRepo>;
}

import { mkdir, writeFile } from "node:fs/promises";

const BROWSER_PROTOCOL_URL =
  "https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json";
const JS_PROTOCOL_URL =
  "https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json";
const OUTPUT_DIR = "src/browser/data/cdp";

type RawProperty = {
  name?: string;
  type?: string;
  $ref?: string;
  description?: string;
  optional?: boolean;
  experimental?: boolean;
  deprecated?: boolean;
  enum?: string[];
  items?: RawProperty;
};

type RawCommand = {
  name: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  parameters?: RawProperty[];
  returns?: RawProperty[];
};

type RawEvent = {
  name: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  parameters?: RawProperty[];
};

type RawType = {
  id: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  type?: string;
  enum?: string[];
  properties?: RawProperty[];
  items?: RawProperty;
};

type RawDomain = {
  domain: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  dependencies?: string[];
  commands?: RawCommand[];
  events?: RawEvent[];
  types?: RawType[];
};

type RawProtocol = {
  version?: { major?: string; minor?: string };
  domains?: RawDomain[];
};

type FieldSummary = {
  name: string;
  description?: string;
  optional: boolean;
  experimental: boolean;
  deprecated: boolean;
  type?: string;
  ref?: string;
  enum?: string[];
  items?: { type?: string; ref?: string };
};

type NormalizedCommand = {
  name: string;
  method: string;
  description?: string;
  experimental: boolean;
  deprecated: boolean;
  parameters: FieldSummary[];
  returns: FieldSummary[];
};

type NormalizedEvent = {
  name: string;
  event: string;
  description?: string;
  experimental: boolean;
  deprecated: boolean;
  parameters: FieldSummary[];
};

type NormalizedType = {
  id: string;
  name: string;
  description?: string;
  experimental: boolean;
  deprecated: boolean;
  kind?: string;
  enum?: string[];
  properties: FieldSummary[];
  items?: { type?: string; ref?: string };
};

type NormalizedDomain = {
  name: string;
  description?: string;
  experimental: boolean;
  deprecated: boolean;
  dependencies: string[];
  commands: NormalizedCommand[];
  events: NormalizedEvent[];
  types: NormalizedType[];
};

type NormalizedSpec = {
  sources: Array<{ url: string; version: string }>;
  totals: { domains: number; commands: number; events: number; types: number };
  domains: NormalizedDomain[];
};

async function fetchJson(url: string): Promise<RawProtocol> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return (await response.json()) as RawProtocol;
}

function versionLabel(protocol: RawProtocol): string {
  return `${protocol.version?.major ?? "0"}.${protocol.version?.minor ?? "0"}`;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

function toFieldSummary(field: RawProperty): FieldSummary {
  return {
    name: field.name ?? "",
    description: field.description,
    optional: Boolean(field.optional),
    experimental: Boolean(field.experimental),
    deprecated: Boolean(field.deprecated),
    type: field.type,
    ref: field.$ref,
    enum: field.enum ? [...field.enum] : undefined,
    items: field.items ? { type: field.items.type, ref: field.items.$ref } : undefined,
  };
}

function normalizeDomain(domain: RawDomain): NormalizedDomain {
  const commands = (domain.commands ?? [])
    .map((cmd) => ({
      name: cmd.name,
      method: `${domain.domain}.${cmd.name}`,
      description: cmd.description,
      experimental: Boolean(cmd.experimental),
      deprecated: Boolean(cmd.deprecated),
      parameters: (cmd.parameters ?? []).map(toFieldSummary),
      returns: (cmd.returns ?? []).map(toFieldSummary),
    }))
    .sort(byName);

  const events = (domain.events ?? [])
    .map((evt) => ({
      name: evt.name,
      event: `${domain.domain}.${evt.name}`,
      description: evt.description,
      experimental: Boolean(evt.experimental),
      deprecated: Boolean(evt.deprecated),
      parameters: (evt.parameters ?? []).map(toFieldSummary),
    }))
    .sort(byName);

  const types = (domain.types ?? [])
    .map((t) => ({
      id: t.id,
      name: `${domain.domain}.${t.id}`,
      description: t.description,
      experimental: Boolean(t.experimental),
      deprecated: Boolean(t.deprecated),
      kind: t.type,
      enum: t.enum ? [...t.enum] : undefined,
      properties: (t.properties ?? []).map(toFieldSummary),
      items: t.items ? { type: t.items.type, ref: t.items.$ref } : undefined,
    }))
    .sort(byName);

  return {
    name: domain.domain,
    description: domain.description,
    experimental: Boolean(domain.experimental),
    deprecated: Boolean(domain.deprecated),
    dependencies: [...(domain.dependencies ?? [])].sort(),
    commands,
    events,
    types,
  };
}

function mergeDomains(protocols: RawProtocol[]): RawDomain[] {
  const domainMap = new Map<string, RawDomain>();

  for (const protocol of protocols) {
    for (const domain of protocol.domains ?? []) {
      const existing = domainMap.get(domain.domain);
      if (!existing) {
        domainMap.set(domain.domain, {
          ...domain,
          dependencies: [...(domain.dependencies ?? [])],
          commands: [...(domain.commands ?? [])],
          events: [...(domain.events ?? [])],
          types: [...(domain.types ?? [])],
        });
        continue;
      }

      const mergedDeps = new Set<string>([
        ...(existing.dependencies ?? []),
        ...(domain.dependencies ?? []),
      ]);

      existing.description = existing.description ?? domain.description;
      existing.experimental = Boolean(existing.experimental || domain.experimental);
      existing.deprecated = Boolean(existing.deprecated || domain.deprecated);
      existing.dependencies = [...mergedDeps];
      existing.commands = [...(existing.commands ?? []), ...(domain.commands ?? [])];
      existing.events = [...(existing.events ?? []), ...(domain.events ?? [])];
      existing.types = [...(existing.types ?? []), ...(domain.types ?? [])];
    }
  }

  return [...domainMap.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

async function main(): Promise<void> {
  console.log("Fetching CDP protocol sources...");

  const [browserProtocol, jsProtocol] = await Promise.all([
    fetchJson(BROWSER_PROTOCOL_URL),
    fetchJson(JS_PROTOCOL_URL),
  ]);

  const mergedDomains = mergeDomains([browserProtocol, jsProtocol]);
  const domains = mergedDomains.map(normalizeDomain);

  const totals = domains.reduce(
    (acc, d) => {
      acc.commands += d.commands.length;
      acc.events += d.events.length;
      acc.types += d.types.length;
      return acc;
    },
    { domains: domains.length, commands: 0, events: 0, types: 0 },
  );

  const spec: NormalizedSpec = {
    sources: [
      { url: BROWSER_PROTOCOL_URL, version: versionLabel(browserProtocol) },
      { url: JS_PROTOCOL_URL, version: versionLabel(jsProtocol) },
    ],
    totals,
    domains,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });

  const specPath = `${OUTPUT_DIR}/spec.json`;
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

  const domainNames = spec.domains.map((d) => d.name);
  const domainsTs = [
    "// Auto-generated by scripts/build-cdp-spec.ts",
    `export const CDP_DOMAINS = ${JSON.stringify(domainNames)} as const;`,
    "export type CdpDomain = (typeof CDP_DOMAINS)[number];",
    "",
  ].join("\n");
  await writeFile(`${OUTPUT_DIR}/domains.ts`, domainsTs);

  const summary = { sources: spec.sources, totals: spec.totals };
  await writeFile(`${OUTPUT_DIR}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`Wrote ${specPath}`);
  console.log(
    `Totals: ${totals.domains} domains, ${totals.commands} commands, ${totals.events} events, ${totals.types} types`,
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

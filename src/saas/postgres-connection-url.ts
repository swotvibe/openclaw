export const POSTGRES_SSL_MODES = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
] as const;

export type PostgresSslMode = (typeof POSTGRES_SSL_MODES)[number];

export type SaasPostgresConnectionIssueCode =
  | "connection_url_invalid"
  | "connection_url_scheme_invalid"
  | "host_invalid"
  | "port_invalid"
  | "sslmode_invalid";

export type SaasPostgresConnectionIssue = {
  code: SaasPostgresConnectionIssueCode;
  severity: "error" | "warn";
  message: string;
};

export type SaasPostgresConnectionSource = "connection-url" | "host-parts";

export type SaasPostgresConnectionEnvKeys = {
  connectionUrl: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslMode: string;
};

export type ResolveSaasPostgresConnectionOptions = {
  envKeys?: Partial<SaasPostgresConnectionEnvKeys>;
  defaultDatabase?: string;
  defaultUser?: string;
};

export type SaasPostgresConnection = {
  configured: boolean;
  source?: SaasPostgresConnectionSource;
  connectionUrl?: string;
  redactedConnectionUrl?: string;
  issues: SaasPostgresConnectionIssue[];
};

type NormalizedHost = {
  host: string;
  port?: string;
};

const DEFAULT_ENV_KEYS: SaasPostgresConnectionEnvKeys = {
  connectionUrl: "DATABASE_URL",
  host: "OPENCLAW_POSTGRES_HOST",
  port: "OPENCLAW_POSTGRES_PORT",
  database: "OPENCLAW_POSTGRES_DATABASE",
  user: "OPENCLAW_POSTGRES_USER",
  password: "OPENCLAW_POSTGRES_PASSWORD",
  sslMode: "OPENCLAW_POSTGRES_SSLMODE",
};

const DEFAULT_DATABASE = "openclaw";
const DEFAULT_USER = "openclaw";
const POSTGRES_URI_SCHEME_RE = /^postgres(?:ql)?:\/\//i;
const URL_WITH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function trimEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveEnvKeys(
  overrides: Partial<SaasPostgresConnectionEnvKeys> | undefined,
): SaasPostgresConnectionEnvKeys {
  return { ...DEFAULT_ENV_KEYS, ...overrides };
}

function isPostgresUri(value: string): boolean {
  return POSTGRES_URI_SCHEME_RE.test(value);
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return port;
}

function parseSslMode(value: string | undefined): PostgresSslMode | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return POSTGRES_SSL_MODES.find((mode) => mode === normalized);
}

function normalizeHost(rawHost: string): NormalizedHost | undefined {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    return undefined;
  }

  const parseTarget = URL_WITH_SCHEME_RE.test(trimmed) ? trimmed : `postgresql://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(parseTarget);
  } catch {
    return undefined;
  }

  if (!parsed.hostname) {
    return undefined;
  }
  if (
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    return undefined;
  }

  return {
    host: parsed.hostname,
    ...(parsed.port ? { port: parsed.port } : {}),
  };
}

function buildPostgresUrl(params: {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  sslMode?: PostgresSslMode;
}): string {
  const url = new URL("postgresql://localhost");
  url.hostname = params.host;
  url.port = String(params.port);
  url.username = params.user;
  if (params.password) {
    url.password = params.password;
  }
  url.pathname = `/${params.database}`;
  if (params.sslMode) {
    url.searchParams.set("sslmode", params.sslMode);
  }
  return url.href;
}

export function redactPostgresConnectionUrl(value: string): string {
  if (!isPostgresUri(value)) {
    return "<invalid postgres connection string>";
  }

  try {
    const parsed = new URL(value);
    if (parsed.password) {
      parsed.password = "<redacted>";
    }
    return parsed.href;
  } catch {
    return "<redacted postgres connection string>";
  }
}

export function resolveSaasPostgresConnection(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveSaasPostgresConnectionOptions = {},
): SaasPostgresConnection {
  const keys = resolveEnvKeys(options.envKeys);
  const connectionUrl = trimEnvValue(env[keys.connectionUrl]);
  const issues: SaasPostgresConnectionIssue[] = [];

  if (connectionUrl) {
    if (!isPostgresUri(connectionUrl)) {
      issues.push({
        code: URL_WITH_SCHEME_RE.test(connectionUrl)
          ? "connection_url_scheme_invalid"
          : "connection_url_invalid",
        severity: "error",
        message: `${keys.connectionUrl} must use a postgres:// or postgresql:// URI.`,
      });
      return { configured: false, issues };
    }

    return {
      configured: true,
      source: "connection-url",
      connectionUrl,
      redactedConnectionUrl: redactPostgresConnectionUrl(connectionUrl),
      issues,
    };
  }

  const rawHost = trimEnvValue(env[keys.host]);
  if (!rawHost) {
    return { configured: false, issues };
  }

  const normalizedHost = normalizeHost(rawHost);
  if (!normalizedHost) {
    issues.push({
      code: "host_invalid",
      severity: "error",
      message: `${keys.host} must be a hostname, host:port pair, IPv4/IPv6 literal, or server URL without a path.`,
    });
    return { configured: false, issues };
  }

  const rawPort = trimEnvValue(env[keys.port]) ?? normalizedHost.port ?? "5432";
  const port = parsePort(rawPort);
  if (!port) {
    issues.push({
      code: "port_invalid",
      severity: "error",
      message: `${keys.port} must be an integer from 1 to 65535.`,
    });
  }

  const rawSslMode = trimEnvValue(env[keys.sslMode]);
  const sslMode = parseSslMode(rawSslMode);
  if (rawSslMode && !sslMode) {
    issues.push({
      code: "sslmode_invalid",
      severity: "error",
      message: `${keys.sslMode} must be one of: ${POSTGRES_SSL_MODES.join(", ")}.`,
    });
  }

  if (!port || issues.some((issue) => issue.severity === "error")) {
    return { configured: false, issues };
  }

  const builtUrl = buildPostgresUrl({
    host: normalizedHost.host,
    port,
    database: trimEnvValue(env[keys.database]) ?? options.defaultDatabase ?? DEFAULT_DATABASE,
    user: trimEnvValue(env[keys.user]) ?? options.defaultUser ?? DEFAULT_USER,
    password: trimEnvValue(env[keys.password]),
    ...(sslMode ? { sslMode } : {}),
  });

  return {
    configured: true,
    source: "host-parts",
    connectionUrl: builtUrl,
    redactedConnectionUrl: redactPostgresConnectionUrl(builtUrl),
    issues,
  };
}

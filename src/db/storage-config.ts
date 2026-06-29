import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type StorageMode = "local" | "hybrid" | "remote";

export interface StorageConfig {
  mode: StorageMode;
  postgres: {
    host: string;
    port: number;
    username: string;
    password_env: string;
    ssl: boolean;
  };
}

export interface StorageEnv {
  name: string;
}

const LEGACY_DATABASE_CONFIG_KEY = ["r", "d", "s"].join("");
export const RECORDINGS_STORAGE_ENV = "HASNA_RECORDINGS_DATABASE_URL";
export const RECORDINGS_STORAGE_FALLBACK_ENV = "RECORDINGS_DATABASE_URL";
export const RECORDINGS_STORAGE_MODE_ENV = "HASNA_RECORDINGS_STORAGE_MODE";
export const RECORDINGS_STORAGE_MODE_FALLBACK_ENV = "RECORDINGS_STORAGE_MODE";
export const RECORDINGS_STORAGE_CONFIG_ENV = "HASNA_RECORDINGS_STORAGE_CONFIG";
export const STORAGE_DATABASE_ENV = [RECORDINGS_STORAGE_ENV, RECORDINGS_STORAGE_FALLBACK_ENV] as const;
export const STORAGE_MODE_ENV = [RECORDINGS_STORAGE_MODE_ENV, RECORDINGS_STORAGE_MODE_FALLBACK_ENV] as const;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function normalizeMode(value: string | undefined): StorageMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "hybrid" || normalized === "remote") return normalized;
  return undefined;
}

export function getStorageDatabaseEnvName(): (typeof STORAGE_DATABASE_ENV)[number] | null {
  for (const name of STORAGE_DATABASE_ENV) {
    if (readEnv(name)) return name;
  }
  return null;
}

export function getStorageDatabaseEnv(): StorageEnv | null {
  const name = getStorageDatabaseEnvName();
  return name ? { name } : null;
}

export function getStorageDatabaseUrl(): string | undefined {
  const env = getStorageDatabaseEnv();
  return env ? readEnv(env.name) : undefined;
}

function getStorageConfigPath(): string {
  const override = readEnv(RECORDINGS_STORAGE_CONFIG_ENV);
  if (override) return override;
  return join(homedir(), ".hasna", "recordings", "storage", "config.json");
}

export function getStorageConfig(): StorageConfig {
  const config: StorageConfig = {
    mode: "local",
    postgres: {
      host: "",
      port: 5432,
      username: "",
      password_env: "RECORDINGS_DATABASE_PASSWORD",
      ssl: true,
    },
  };

  const storageConfigPath = getStorageConfigPath();
  if (existsSync(storageConfigPath)) {
    try {
      const raw = JSON.parse(readFileSync(storageConfigPath, "utf-8")) as Partial<StorageConfig> & Record<string, unknown>;
      const legacyDatabaseConfig =
        typeof raw[LEGACY_DATABASE_CONFIG_KEY] === "object" && raw[LEGACY_DATABASE_CONFIG_KEY] !== null
          ? raw[LEGACY_DATABASE_CONFIG_KEY] as Partial<StorageConfig["postgres"]>
          : {};
      config.mode = normalizeMode(raw.mode) ?? config.mode;
      config.postgres = { ...config.postgres, ...legacyDatabaseConfig, ...(raw.postgres ?? {}) };
    } catch {
      // Ignore malformed storage config and fall back to local mode.
    }
  }

  const modeOverride = readEnv(RECORDINGS_STORAGE_MODE_ENV) ?? readEnv(RECORDINGS_STORAGE_MODE_FALLBACK_ENV);
  const normalizedMode = normalizeMode(modeOverride);
  if (normalizedMode) {
    config.mode = normalizedMode;
  } else if (getStorageDatabaseUrl() && config.mode === "local") {
    config.mode = "hybrid";
  }

  return config;
}

export function getStorageConnectionString(dbName = "recordings"): string {
  const direct = getStorageDatabaseUrl();
  if (direct) return direct;

  const config = getStorageConfig();
  const { host, port, username, password_env, ssl } = config.postgres;
  if (!host || !username) {
    throw new Error("Storage database is not configured. Set HASNA_RECORDINGS_DATABASE_URL or configure ~/.hasna/recordings/storage/config.json.");
  }

  const password = process.env[password_env];
  if (!password) {
    throw new Error(`Storage database password is not set. Export ${password_env}.`);
  }

  const sslParam = ssl ? "?sslmode=require" : "";
  return `postgres://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbName}${sslParam}`;
}

export const getConnectionString = getStorageConnectionString;

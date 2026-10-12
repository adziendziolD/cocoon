import { z } from 'zod';
import { LocalizedText } from './models.ts';

/**
 * Shared services: databases and mocks that CoCoon runs once on the server (or connects to) and offers to every
 * sandbox. Each sandbox gets its own database + user (or its own URL prefix for mocks), handed to agents as env vars.
 */
export const ServiceKind = z.enum(['postgres', 'mysql', 'mongodb', 'redis', 'wiremock', 'mailpit']);
export type ServiceKind = z.infer<typeof ServiceKind>;

export const SERVICE_ID = /^[a-z][a-z0-9-]{0,30}$/;

/** How long a managed service may run without any running sandbox using it before it is paused. */
export const SERVICE_IDLE_MINUTES = 10;

export interface ServiceKindInfo {
  label: string;
  category: 'database' | 'mock';
  description: LocalizedText;
  /** Container images offered for managed services; the first is the default. */
  images: { ref: string; label: string }[];
  /** Main port (inside the container and for external servers). */
  port: number;
  /** How sandboxes are separated: own database + user, own URL prefix, or shared. */
  isolation: 'database' | 'prefix' | 'shared';
  /** Whether an external server needs admin credentials. */
  externalAuth: boolean;
  defaultAdminUser?: string;
  /** Env vars agents get (documentation for the UI). */
  env: string[];
}

export const SERVICE_KINDS: Record<ServiceKind, ServiceKindInfo> = {
  postgres: {
    label: 'PostgreSQL',
    category: 'database',
    description: {
      de: 'Relationale Datenbank. Jede Sandbox bekommt eine eigene Datenbank mit eigenem Benutzer und darf darin beliebig Schemata und Test-Datenbanken anlegen.',
      en: 'Relational database. Every sandbox gets its own database and user and may create any schemas and test databases in it.',
    },
    images: [
      { ref: 'docker.io/library/postgres:17-alpine', label: 'PostgreSQL 17' },
      { ref: 'docker.io/library/postgres:16-alpine', label: 'PostgreSQL 16' },
    ],
    port: 5432,
    isolation: 'database',
    externalAuth: true,
    defaultAdminUser: 'postgres',
    env: ['DATABASE_URL', 'POSTGRES_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'],
  },
  mysql: {
    label: 'MySQL / MariaDB',
    category: 'database',
    description: {
      de: 'Relationale Datenbank (MySQL-kompatibel). Jede Sandbox bekommt eine eigene Datenbank und darf weitere mit ihrem Namen als Präfix anlegen.',
      en: 'Relational database (MySQL compatible). Every sandbox gets its own database and may create more prefixed with its name.',
    },
    images: [
      { ref: 'docker.io/library/mariadb:11', label: 'MariaDB 11' },
      { ref: 'docker.io/library/mysql:8.4', label: 'MySQL 8.4' },
    ],
    port: 3306,
    isolation: 'database',
    externalAuth: true,
    defaultAdminUser: 'root',
    env: ['MYSQL_URL', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
  },
  mongodb: {
    label: 'MongoDB',
    category: 'database',
    description: {
      de: 'Dokumenten-Datenbank. Jede Sandbox bekommt eine eigene Datenbank mit eigenem Benutzer.',
      en: 'Document database. Every sandbox gets its own database and user.',
    },
    images: [
      { ref: 'docker.io/library/mongo:8', label: 'MongoDB 8' },
      { ref: 'docker.io/library/mongo:7', label: 'MongoDB 7' },
    ],
    port: 27017,
    isolation: 'database',
    externalAuth: true,
    defaultAdminUser: 'root',
    env: ['MONGODB_URI', 'MONGO_URL'],
  },
  redis: {
    label: 'Redis',
    category: 'database',
    description: {
      de: 'Schneller Schlüssel-Wert-Speicher (Cache, Warteschlangen). Jede Sandbox bekommt einen eigenen Benutzer, der nur Schlüssel mit ihrem Präfix sieht.',
      en: 'Fast key-value store (cache, queues). Every sandbox gets its own user that only sees keys with its prefix.',
    },
    images: [
      { ref: 'docker.io/library/redis:7-alpine', label: 'Redis 7' },
      { ref: 'docker.io/library/redis:8-alpine', label: 'Redis 8' },
    ],
    port: 6379,
    isolation: 'database',
    externalAuth: true,
    defaultAdminUser: 'default',
    env: ['REDIS_URL', 'REDIS_KEY_PREFIX'],
  },
  wiremock: {
    label: 'WireMock',
    category: 'mock',
    description: {
      de: 'Nachgebaute HTTP-APIs für Tests: Agenten legen Antworten (Stubs) fest, statt echte Dienste aufzurufen. Jede Sandbox nutzt ein eigenes URL-Präfix; ihre Stubs werden beim Löschen aufgeräumt.',
      en: 'Mocked HTTP APIs for tests: agents define responses (stubs) instead of calling real services. Every sandbox uses its own URL prefix; its stubs are cleaned up on deletion.',
    },
    images: [{ ref: 'docker.io/wiremock/wiremock:3x', label: 'WireMock 3' }],
    port: 8080,
    isolation: 'prefix',
    externalAuth: false,
    env: ['MOCK_API_URL', 'WIREMOCK_URL', 'WIREMOCK_ADMIN_URL', 'MOCK_API_PREFIX'],
  },
  mailpit: {
    label: 'Mailpit',
    category: 'mock',
    description: {
      de: 'Fängt E-Mails ab, statt sie zu verschicken. Agenten senden per SMTP und lesen die Mails über die API; du siehst sie in der Web-Oberfläche.',
      en: 'Catches emails instead of sending them. Agents send via SMTP and read the mails through the API; you see them in the web interface.',
    },
    images: [{ ref: 'docker.io/axllent/mailpit:latest', label: 'Mailpit' }],
    port: 1025,
    isolation: 'shared',
    externalAuth: false,
    env: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_URL', 'MAILPIT_API_URL'],
  },
};

/** idle = paused automatically because no running sandbox uses it; starts again on demand. */
export const ServiceStatus = z.enum(['running', 'starting', 'pulling', 'idle', 'stopped', 'error', 'unsupported']);
export type ServiceStatus = z.infer<typeof ServiceStatus>;

export const SharedService = z.object({
  id: z.string().regex(SERVICE_ID),
  kind: ServiceKind,
  label: z.string().max(80).optional(),
  /** managed = CoCoon runs a container; external = an existing server CoCoon connects to. */
  mode: z.enum(['managed', 'external']),
  /** managed: container image. */
  image: z.string().optional(),
  /** managed: memory limit. */
  memoryMb: z.number().int().min(128).optional(),
  /** external: address as seen from the CoCoon server ("localhost" = the server itself). */
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  adminUser: z.string().optional(),
  tls: z.boolean().optional(),
  /** all = every new sandbox gets it automatically; manual = only when selected. */
  attach: z.enum(['all', 'manual']).default('all'),
  /** managed: pause when no running sandbox has used it for a while, start again on demand (default true). */
  autoStop: z.boolean().optional(),
  createdAt: z.string(),
});
export type SharedService = z.infer<typeof SharedService>;

export const ServiceInfo = SharedService.extend({
  status: ServiceStatus,
  error: z.string().optional(),
  /** Version reported by the server, if connected. */
  version: z.string().optional(),
  hasAdminPassword: z.boolean(),
  /** managed: ports published on 127.0.0.1 of the CoCoon server (by container port). */
  hostPorts: z.record(z.string(), z.number()).default({}),
  /** managed mailpit/wiremock: web interface on the server. */
  webUrl: z.string().optional(),
  /** Sandboxes that have this service. */
  sandboxes: z.array(z.string()).default([]),
});
export type ServiceInfo = z.infer<typeof ServiceInfo>;

export const ServiceConnection = z.object({
  serviceId: z.string(),
  kind: ServiceKind,
  label: z.string(),
  host: z.string(),
  port: z.number(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  url: z.string(),
  env: z.record(z.string(), z.string()),
  error: z.string().optional(),
});
export type ServiceConnection = z.infer<typeof ServiceConnection>;

export const ServiceAdminCredentials = z.object({
  host: z.string(),
  port: z.number(),
  user: z.string().optional(),
  password: z.string().optional(),
  url: z.string(),
});
export type ServiceAdminCredentials = z.infer<typeof ServiceAdminCredentials>;

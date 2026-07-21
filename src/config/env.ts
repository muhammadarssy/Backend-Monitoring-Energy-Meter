import 'dotenv/config';

/**
 * Konfigurasi server dari environment / file .env.
 * Sumber data nyata: Redis (live) + PostgreSQL (history).
 */
export const env = {
  port: parseInt(process.env.PORT || '5000', 10),

  // Redis — mirror buffer & device info dari collector
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379/0',
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || 'energy',

  // PostgreSQL — penyimpanan historis (readings, sessions, cycles)
  dbUrl: process.env.DB_URL || 'postgresql://user:pass@localhost:5432/energy_db',
  dbPoolMax: Math.max(1, parseInt(process.env.DB_POOL_MAX || '4', 10)),
  dbConnectionTimeoutMs: Math.max(
    1000,
    parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10)
  ),
  dbIdleTimeoutMs: Math.max(1000, parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000', 10)),

  // Cache singkat untuk menggabungkan polling summary yang berdekatan.
  summaryCacheTtlMs: Math.max(0, parseInt(process.env.SUMMARY_CACHE_TTL_MS || '2000', 10)),

  // Sample dianggap basi (mesin offline) bila timestamp latest lebih tua dari ini.
  offlineThresholdSeconds: parseFloat(process.env.OFFLINE_THRESHOLD_SECONDS || '10'),

  // Jendela waktu power-graph (jam) dan ukuran bucket agregasi (menit).
  powerGraphWindowHours: parseFloat(process.env.POWER_GRAPH_WINDOW_HOURS || '4'),
  powerGraphBucketMinutes: parseFloat(process.env.POWER_GRAPH_BUCKET_MINUTES || '5'),

  // Timezone offset untuk field rtc/timestamp pada response (menit). UTC+7 = 420.
  tzOffsetMinutes: parseInt(process.env.TZ_OFFSET_MINUTES || '420', 10),
  tzLabel: process.env.TZ_LABEL || 'UTC+7',
};

import express from 'express';
import cors from 'cors';
import energyRouter from './routes/energy.js';
import loadRouter from './routes/load.js';
import reportRouter from './routes/report.js';
import simpleReportRouter from './routes/simpleReport.js';
import billingRouter from './routes/billing.js';
import { env } from './config/env.js';
import { pingDb } from './lib/db.js';
import { pingDatamart } from './lib/datamart.js';
import { redis } from './lib/redisClient.js';

const app = express();
const PORT = env.port;

// Enable CORS for frontend integration
app.use(cors({
  origin: '*', // Allow all origins for local server development
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parse JSON request bodies
app.use(express.json());

// Log incoming requests for debugging/verification
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Root API welcome endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Chint DTSU666 Energy Monitor API Server (Redis + PostgreSQL)',
    endpoints: {
      summary: '/api/dashboard/summary',
      telemetry: '/api/dashboard/machines/:id/telemetry',
      telemetry_buffer: '/api/dashboard/machines/:id/telemetry/buffer',
      device_info: '/api/dashboard/machines/:id/device-info',
      power_graph: '/api/dashboard/machines/:id/power-graph',
      power_history: '/api/dashboard/machines/:id/power-history',
      load: '/api/dashboard/load',
      report: '/api/dashboard/report',
      simple_report: '/api/dashboard/simple-report',
      billing: '/api/dashboard/billing',
      billing_tenants: '/api/dashboard/billing/tenants',
      billing_day_notes: '/api/dashboard/billing/day-notes',
      billing_day_sewa: '/api/dashboard/billing/day-sewa',
      health: '/health'
    }
  });
});

const redactUrl = (url: string) => url.replace(/:[^:@/]+@/, ':****@');

// Health check — status koneksi sumber data
app.get('/health', async (req, res) => {
  const [dbOk, datamart] = await Promise.all([pingDb(), pingDatamart()]);
  const redisOk = redis.status === 'ready';
  const healthy = dbOk && redisOk && datamart.ok && datamart.schema;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    redis: redisOk ? 'connected' : redis.status,
    postgres: dbOk ? 'connected' : 'unavailable',
    datamart: datamart.ok ? 'connected' : 'unavailable',
    datamart_schema: datamart.schema ? 'present' : 'missing',
  });
});

// Register routes
app.use('/api/dashboard', energyRouter);
app.use('/api/dashboard', loadRouter);
app.use('/api/dashboard', reportRouter);
app.use('/api/dashboard', simpleReportRouter);
app.use('/api/dashboard', billingRouter);

// Start listening
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Chint DTSU666 API Server is running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`⚡ API Root: http://localhost:${PORT}/api/dashboard`);
  console.log(`📦 Redis: ${env.redisUrl} (prefix: ${env.redisKeyPrefix})`);
  console.log(`🗄️  PostgreSQL (collector): ${redactUrl(env.dbUrl)}`);
  console.log(`📊 PostgreSQL (datamart):   ${redactUrl(env.datamartDbUrl)} (tz: ${env.datamartTimezone})`);
  console.log(`===================================================`);
  console.log(`Endpoints available:`);
  console.log(` - GET /api/dashboard/summary`);
  console.log(` - GET /api/dashboard/machines/:id/telemetry`);
  console.log(` - GET /api/dashboard/machines/:id/telemetry/buffer`);
  console.log(` - GET /api/dashboard/machines/:id/device-info`);
  console.log(` - GET /api/dashboard/machines/:id/power-graph`);
  console.log(` - GET /api/dashboard/machines/:id/power-history`);
  console.log(` - GET /api/dashboard/load`);
  console.log(` - GET /api/dashboard/report`);
  console.log(` - GET /api/dashboard/simple-report`);
  console.log(` - GET /api/dashboard/billing?from=YYYY-MM-DD`);
  console.log(` - PUT /api/dashboard/billing`);
  console.log(` - GET /api/dashboard/billing/tenants`);
  console.log(` - GET /api/dashboard/billing/day-notes?from=&to=`);
  console.log(` - PUT /api/dashboard/billing/day-notes`);
  console.log(` - GET /api/dashboard/billing/day-sewa?from=&to=`);
  console.log(` - PUT /api/dashboard/billing/day-sewa`);
  console.log(` - POST /api/dashboard/billing/tenants`);
  console.log(` - GET /health`);
  console.log(`===================================================`);
});

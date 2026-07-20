import express from 'express';
import cors from 'cors';
import energyRouter from './routes/energy.js';
import { env } from './config/env.js';
import { pingDb } from './lib/db.js';
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
      health: '/health'
    }
  });
});

// Health check — status koneksi sumber data
app.get('/health', async (req, res) => {
  const dbOk = await pingDb();
  const redisOk = redis.status === 'ready';
  res.status(dbOk && redisOk ? 200 : 503).json({
    status: dbOk && redisOk ? 'ok' : 'degraded',
    redis: redisOk ? 'connected' : redis.status,
    postgres: dbOk ? 'connected' : 'unavailable'
  });
});

// Register routes
app.use('/api/dashboard', energyRouter);

// Start listening
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Chint DTSU666 API Server is running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`⚡ API Root: http://localhost:${PORT}/api/dashboard`);
  console.log(`📦 Redis: ${env.redisUrl} (prefix: ${env.redisKeyPrefix})`);
  console.log(`🗄️  PostgreSQL: ${env.dbUrl.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`===================================================`);
  console.log(`Endpoints available:`);
  console.log(` - GET /api/dashboard/summary`);
  console.log(` - GET /api/dashboard/machines/:id/telemetry`);
  console.log(` - GET /api/dashboard/machines/:id/telemetry/buffer`);
  console.log(` - GET /api/dashboard/machines/:id/device-info`);
  console.log(` - GET /api/dashboard/machines/:id/power-graph`);
  console.log(` - GET /api/dashboard/machines/:id/power-history`);
  console.log(` - GET /health`);
  console.log(`===================================================`);
});

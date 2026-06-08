import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { initDatabase } from './db';
import { captureMiddleware, isWriteOperation } from './middleware/capture';
import apiRoutes from './routes/api';
import companyRoutes from './routes/company';
import changesetRoutes from './routes/changesets';
import { forwardReadRequest } from './utils/executor';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: restrict to an explicit allowlist instead of reflecting any origin.
// Defaults to the local review UI. A wildcard policy would let any website the
// user visits issue cross-origin write/approval requests against this server.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || `http://localhost:${PORT}`)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients (no Origin header) and allowlisted origins only.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
  })
);

app.use(express.json());

// Optional shared-secret guard for state-changing operations. When PROXY_AUTH_TOKEN
// is set, every mutating request (POST/PUT/PATCH/DELETE) — including proxy writes,
// approvals, rejections and deletes — must present the token via either
// `Authorization: Bearer <token>` or an `X-Proxy-Token` header. Reads stay open.
// When the env var is unset the guard is disabled (unchanged dev behavior).
const PROXY_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

app.use((req, res, next) => {
  if (!PROXY_AUTH_TOKEN) return next();
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return next();

  const authHeader = req.headers['authorization'];
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;
  const provided = bearer || (req.headers['x-proxy-token'] as string | undefined);

  if (provided && timingSafeEqualStr(provided, PROXY_AUTH_TOKEN)) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: a valid proxy auth token is required for write operations',
  });
});

app.use(express.static('public'));

// API Routes
app.use('/api', apiRoutes);
app.use('/api', companyRoutes);
app.use('/api', changesetRoutes);

// Proxy endpoint - captures writes, forwards reads
app.all('/proxy/*', captureMiddleware, async (req, res) => {
  // If it's a write operation, captureMiddleware already responded
  if (isWriteOperation(req.method)) {
    return;
  }
  
  // Forward read requests to the actual API
  try {
    // Remove /proxy prefix - the base URL already includes /v1
    const targetPath = req.path.replace('/proxy', '');
    const result = await forwardReadRequest(
      req.method,
      targetPath,
      req.query as Record<string, string>,
      Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)])
      )
    );
    
    res.json(result);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to forward request',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Serve review UI
app.get('/review/:id?', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public/index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test API connectivity
app.get('/test-connection', async (req, res) => {
  try {
    const { forwardReadRequest } = await import('./utils/executor');
    const result = await forwardReadRequest(
      'GET',
      '/accounts',
      {},
      {}
    );
    res.json({ 
      success: true, 
      message: 'Successfully connected to e-Financials API',
      data: result
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to connect to e-Financials API',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Initialize and start
async function start() {
  try {
    await initDatabase();
    console.log('Database initialized');
    
    app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════════════════════╗
║           e-arveldaja Proxy Server                       ║
╠══════════════════════════════════════════════════════════╣
║  Port:        ${PORT.toString().padEnd(45)}║
║  API:         http://localhost:${PORT}/api${' '.repeat(23)}║
║  Review UI:   http://localhost:${PORT}/review${' '.repeat(20)}║
║  Proxy:       http://localhost:${PORT}/proxy${' '.repeat(21)}║
╚══════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

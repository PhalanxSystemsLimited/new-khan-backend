// Vercel entry point (serverless). Vercel calls the Express app for every request; backend/vercel.json sends all
// paths here. Not used on a long-running server (Hostinger VPS / PM2), which starts src/server.js instead.
// Nothing here differs from src/server.js except that there is no listen() and no in-process minute job:
// expired seat holds are released by GET /api/v1/internal/expire-bookings (Vercel Cron) and on search / seat maps.
import { createApp } from '../src/app.js';

export default createApp();

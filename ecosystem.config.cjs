// PM2 config for a Hostinger VPS:  pm2 start ecosystem.config.cjs && pm2 save
// Keep instances at 1: rate limits and the booking-expiry job are in-process.
module.exports = {
  apps: [
    {
      name: 'new-khan-api',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
      kill_timeout: 10000,
      time: true,
    },
  ],
};

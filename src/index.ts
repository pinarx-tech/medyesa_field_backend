import { getEnv } from './env.js';
import { buildApp } from './app.js';
import { disconnectPrisma } from './lib/prisma.js';

async function start(): Promise<void> {
  const env = getEnv();
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down Medyesa Field API');
    await app.close();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: '0.0.0.0', port: env.PORT });
}

start().catch(async (err) => {
  console.error('Fatal startup error:', err);
  await disconnectPrisma();
  process.exit(1);
});

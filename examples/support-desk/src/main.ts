import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule, usingRealModel } from './app.module';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(
    `support-desk demo on http://localhost:${port} (${usingRealModel ? 'real Jev model' : 'keyword demo provider, not a model'})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

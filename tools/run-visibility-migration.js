const { PrismaClient } = require('@prisma/client');

async function migrate() {
  const p = new PrismaClient();
  try {
    await p.$executeRaw`
      ALTER TABLE "Pick"
      ADD COLUMN IF NOT EXISTS "visibility" TEXT
      NOT NULL DEFAULT 'PUBLIC'
    `;
    console.log('Migration SUCCESS: visibility column added to Pick');
  } catch (e) {
    console.error('Migration FAILED:', e.message);
    process.exit(1);
  } finally {
    await p.$disconnect();
  }
}

migrate();

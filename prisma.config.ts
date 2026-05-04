

import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.DIRECT_URL,
})

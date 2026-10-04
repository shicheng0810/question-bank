import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
// Every test uses fresh UUID object names. Installed pool's stacked SQLite
// isolation fails on sqlite-shm after a rejected real RPC; fresh names avoid
// that harness bug without replacing or mocking the actual runtime/storage.
export default defineWorkersConfig({test:{include:['tests/report-runtime/*.test.js'],poolOptions:{workers:{wrangler:{configPath:'./tests/report-runtime/wrangler.jsonc'},remoteBindings:false,isolatedStorage:false}}}});

// A single-node MongoDB replica set on 27018 (what Payload's test docker-compose provides), from mongodb-memory-server
import { createRequire } from 'node:module'
const require = createRequire(`${process.env.PAYLOAD_DIR ?? process.cwd()}/packages/db-mongodb/package.json`)
const { MongoMemoryReplSet } = require('mongodb-memory-server')
const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
  instanceOpts: [{ port: 27018, ip: '127.0.0.1' }],
})
console.log('mongo up', rs.getUri())
process.on('SIGTERM', async () => { await rs.stop(); process.exit(0) })
setInterval(() => {}, 1 << 30)

globalThis.chrome = globalThis.browser ? globalThis.browser : globalThis.chrome

const DB_META_KEY = "ListingsDBMeta"
const DB_SHARD_PREFIX = "ListingsDBShard:"
const DB_VERSION = 2
const SHARD_MAX_BYTES = 80 * 1024
const TITLE_MAX_CHARS = 80
const MAX_WRITE_ATTEMPTS = 2

function now() {
   return Date.now()
}

function shardStorageKey(shardId) {
   return `${DB_SHARD_PREFIX}${shardId}`
}

function createEmptyMeta(nextShardSeq = 1) {
   return {
      version: DB_VERSION,
      shardIds: [],
      listingToShard: {},
      nextShardSeq,
      updatedAt: now()
   }
}

function clone(value) {
   return JSON.parse(JSON.stringify(value))
}

function normalizeMeta(meta) {
   if (!meta || typeof meta !== "object") return null
   if (meta.version !== DB_VERSION) return null

   const shardIds = Array.isArray(meta.shardIds) ? [...new Set(meta.shardIds.filter(Boolean))] : []
   const listingToShard = (meta.listingToShard && typeof meta.listingToShard === "object")
      ? { ...meta.listingToShard }
      : {}
   const nextShardSeq = Number.isInteger(meta.nextShardSeq) && meta.nextShardSeq > 0
      ? meta.nextShardSeq
      : 1

   return {
      version: DB_VERSION,
      shardIds,
      listingToShard,
      nextShardSeq,
      updatedAt: Number(meta.updatedAt) || 0
   }
}

function serializeMeta(meta) {
   return JSON.stringify(normalizeMeta(meta))
}

async function readMeta() {
   const { [DB_META_KEY]: meta } = await chrome.storage.sync.get([DB_META_KEY])
   return normalizeMeta(meta)
}

async function writeMeta(meta) {
   await chrome.storage.sync.set({
      [DB_META_KEY]: {
         ...normalizeMeta(meta),
         updatedAt: now()
      }
   })
}

async function ensureMeta() {
   const meta = await readMeta()
   if (meta) return meta

   const freshMeta = createEmptyMeta()
   await chrome.storage.sync.set({ [DB_META_KEY]: freshMeta })
   return freshMeta
}

async function readShard(shardId) {
   const key = shardStorageKey(shardId)
   const { [key]: shard } = await chrome.storage.sync.get([key])
   if (!shard || typeof shard !== "object") return null

   const items = (shard.items && typeof shard.items === "object")
      ? shard.items
      : {}
   return {
      items: { ...items },
      updatedAt: Number(shard.updatedAt) || 0
   }
}

async function readShards(shardIds) {
   if (!shardIds.length) return {}

   const shardKeys = shardIds.map(shardStorageKey)
   const raw = await chrome.storage.sync.get(shardKeys)
   const shards = {}

   for (const shardId of shardIds) {
      const payload = raw[shardStorageKey(shardId)]
      if (!payload || typeof payload !== "object") {
         shards[shardId] = null
         continue
      }
      shards[shardId] = {
         items: (payload.items && typeof payload.items === "object")
            ? { ...payload.items }
            : {},
         updatedAt: Number(payload.updatedAt) || 0
      }
   }
   return shards
}

function estimateBytes(value) {
   const bytes = new TextEncoder().encode(JSON.stringify(value))
   return bytes.length
}

function truncateTitle(listing) {
   if (!listing || typeof listing !== "object") return listing
   if (typeof listing.title !== "string") return { ...listing }

   return {
      ...listing,
      title: listing.title.slice(0, TITLE_MAX_CHARS)
   }
}

function canFitInShard(shard, listingKey, listingValue) {
   const nextShard = {
      items: {
         ...(shard?.items || {}),
         [listingKey]: listingValue
      },
      updatedAt: now()
   }
   return estimateBytes(nextShard) <= SHARD_MAX_BYTES
}

function allocateShardId(meta) {
   const shardId = `s${meta.nextShardSeq}`
   meta.nextShardSeq += 1
   return shardId
}

function pruneMissingShards(meta, shards) {
   const missingShardIds = []
   for (const shardId of [...meta.shardIds]) {
      if (shards[shardId]) continue
      missingShardIds.push(shardId)
      meta.shardIds = meta.shardIds.filter((id) => id !== shardId)
   }

   if (!missingShardIds.length) return false

   for (const listingKey of Object.keys(meta.listingToShard)) {
      if (missingShardIds.includes(meta.listingToShard[listingKey])) {
         delete meta.listingToShard[listingKey]
      }
   }
   return true
}

async function commitWithGuard(baseMeta, nextMeta, shardUpserts, shardDeletes) {
   const latestMeta = await readMeta()
   if (serializeMeta(latestMeta) !== serializeMeta(baseMeta)) {
      return false
   }

   if (Object.keys(shardUpserts).length) {
      await chrome.storage.sync.set(shardUpserts)
   }
   if (shardDeletes.length) {
      await chrome.storage.sync.remove(shardDeletes.map(shardStorageKey))
   }
   await writeMeta(nextMeta)
   return true
}

async function getAllListings() {
   const meta = await ensureMeta()
   const shards = await readShards(meta.shardIds)
   const didPrune = pruneMissingShards(meta, shards)
   const listings = {}

   for (const shardId of meta.shardIds) {
      const shard = shards[shardId]
      if (!shard) continue
      Object.assign(listings, shard.items)
   }

   if (didPrune) {
      await writeMeta(meta)
   }
   return listings
}

async function getListing(listingKey) {
   const meta = await ensureMeta()
   const shardId = meta.listingToShard[listingKey]
   if (!shardId) return null

   const shard = await readShard(shardId)
   if (!shard) {
      delete meta.listingToShard[listingKey]
      meta.shardIds = meta.shardIds.filter((id) => id !== shardId)
      await writeMeta(meta)
      return null
   }

   const listing = shard.items[listingKey]
   if (listing) return listing

   delete meta.listingToShard[listingKey]
   await writeMeta(meta)
   return null
}

async function upsertListing(rawListing) {
   if (!rawListing?.key) {
      throw new Error("Listing key is required")
   }

   const listing = truncateTitle(rawListing)

   for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const baseMeta = await ensureMeta()
      const nextMeta = clone(baseMeta)
      const shardUpserts = {}
      const shardDeletes = []
      const shards = await readShards(nextMeta.shardIds)
      pruneMissingShards(nextMeta, shards)

      const listingKey = listing.key
      let currentShardId = nextMeta.listingToShard[listingKey]
      if (currentShardId && !shards[currentShardId]) {
         delete nextMeta.listingToShard[listingKey]
         currentShardId = undefined
      }

      if (currentShardId) {
         const currentShard = shards[currentShardId]
         if (canFitInShard(currentShard, listingKey, listing)) {
            const nextShard = {
               ...currentShard,
               items: {
                  ...currentShard.items,
                  [listingKey]: listing
               },
               updatedAt: now()
            }
            shardUpserts[shardStorageKey(currentShardId)] = nextShard
            const committed = await commitWithGuard(baseMeta, nextMeta, shardUpserts, shardDeletes)
            if (committed) return listing
            continue
         }
      }

      if (currentShardId && shards[currentShardId]) {
         const nextItems = { ...shards[currentShardId].items }
         delete nextItems[listingKey]
         if (!Object.keys(nextItems).length) {
            nextMeta.shardIds = nextMeta.shardIds.filter((id) => id !== currentShardId)
            shardDeletes.push(currentShardId)
         } else {
            shardUpserts[shardStorageKey(currentShardId)] = {
               items: nextItems,
               updatedAt: now()
            }
         }
      }

      let targetShardId = null
      for (const shardId of nextMeta.shardIds) {
         const stagedShard = shardUpserts[shardStorageKey(shardId)] || shards[shardId]
         if (stagedShard && canFitInShard(stagedShard, listingKey, listing)) {
            targetShardId = shardId
            break
         }
      }

      if (!targetShardId) {
         const newShardId = allocateShardId(nextMeta)
         const emptyShard = { items: {}, updatedAt: now() }
         if (!canFitInShard(emptyShard, listingKey, listing)) {
            throw new Error("Listing too large for sync storage")
         }
         nextMeta.shardIds.push(newShardId)
         targetShardId = newShardId
      }

      const targetStorageKey = shardStorageKey(targetShardId)
      const targetShard = shardUpserts[targetStorageKey] || shards[targetShardId] || { items: {}, updatedAt: 0 }
      shardUpserts[targetStorageKey] = {
         ...targetShard,
         items: {
            ...targetShard.items,
            [listingKey]: listing
         },
         updatedAt: now()
      }
      nextMeta.listingToShard[listingKey] = targetShardId

      const committed = await commitWithGuard(baseMeta, nextMeta, shardUpserts, shardDeletes)
      if (committed) return listing
   }

   throw new Error("Failed to write listing due to concurrent updates")
}

async function removeListing(listingKey) {
   for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const baseMeta = await ensureMeta()
      if (!baseMeta.listingToShard[listingKey]) return false

      const nextMeta = clone(baseMeta)
      const shardId = nextMeta.listingToShard[listingKey]
      const shard = await readShard(shardId)
      const shardUpserts = {}
      const shardDeletes = []

      delete nextMeta.listingToShard[listingKey]

      if (!shard) {
         nextMeta.shardIds = nextMeta.shardIds.filter((id) => id !== shardId)
      } else {
         const nextItems = { ...shard.items }
         delete nextItems[listingKey]
         if (!Object.keys(nextItems).length) {
            nextMeta.shardIds = nextMeta.shardIds.filter((id) => id !== shardId)
            shardDeletes.push(shardId)
         } else {
            shardUpserts[shardStorageKey(shardId)] = {
               items: nextItems,
               updatedAt: now()
            }
         }
      }

      const committed = await commitWithGuard(baseMeta, nextMeta, shardUpserts, shardDeletes)
      if (committed) return true
   }

   throw new Error("Failed to delete listing due to concurrent updates")
}

async function replaceAllListings(listings) {
   const input = listings && typeof listings === "object" ? listings : {}
   const normalizedListings = Object.values(input)
      .filter((listing) => listing?.key)
      .map(truncateTitle)

   for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const baseMeta = await ensureMeta()
      const nextMeta = createEmptyMeta(baseMeta.nextShardSeq)
      const shardMap = {}

      for (const listing of normalizedListings) {
         let targetShardId = null
         for (const shardId of nextMeta.shardIds) {
            if (canFitInShard(shardMap[shardId], listing.key, listing)) {
               targetShardId = shardId
               break
            }
         }

         if (!targetShardId) {
            targetShardId = allocateShardId(nextMeta)
            nextMeta.shardIds.push(targetShardId)
            shardMap[targetShardId] = { items: {}, updatedAt: now() }

            if (!canFitInShard(shardMap[targetShardId], listing.key, listing)) {
               throw new Error("Listing too large for sync storage")
            }
         }

         shardMap[targetShardId] = {
            items: {
               ...shardMap[targetShardId].items,
               [listing.key]: listing
            },
            updatedAt: now()
         }
         nextMeta.listingToShard[listing.key] = targetShardId
      }

      const shardUpserts = {}
      for (const shardId of nextMeta.shardIds) {
         shardUpserts[shardStorageKey(shardId)] = shardMap[shardId]
      }

      const shardDeletes = baseMeta.shardIds.filter((shardId) => !nextMeta.shardIds.includes(shardId))
      const committed = await commitWithGuard(baseMeta, nextMeta, shardUpserts, shardDeletes)
      if (committed) {
         const byKey = {}
         for (const listing of normalizedListings) {
            byKey[listing.key] = listing
         }
         return byKey
      }
   }

   throw new Error("Failed to replace listings due to concurrent updates")
}

async function migrateLegacyListingsIfNeeded() {
   const currentMeta = await readMeta()
   if (currentMeta) return

   await chrome.storage.sync.set({ [DB_META_KEY]: createEmptyMeta() })

   const { Listings } = await chrome.storage.sync.get(["Listings"])
   if (Listings && typeof Listings === "object") {
      for (const listingKey of Object.keys(Listings)) {
         const listing = Listings[listingKey]
         if (!listing || typeof listing !== "object") continue
         await upsertListing({
            ...listing,
            key: listing.key || listingKey
         })
      }
   }

   await chrome.storage.sync.remove(["Listings"])
}

async function initListingsDb() {
   await migrateLegacyListingsIfNeeded()
   await ensureMeta()
}

globalThis.ListingsDB = {
   DB_META_KEY,
   DB_SHARD_PREFIX,
   DB_VERSION,
   SHARD_MAX_BYTES,
   TITLE_MAX_CHARS,
   initListingsDb,
   getAllListings,
   getListingByKey: getListing,
   upsertListing,
   removeListing,
   replaceAllListings
}

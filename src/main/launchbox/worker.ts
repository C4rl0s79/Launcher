import { parentPort, workerData } from 'node:worker_threads'
import { buildDatabase, openZipEntry } from './builder'

// Worker entry: unzip Metadata.xml and build the SQLite file without blocking the main process.
const { zipPath, outPath } = workerData as { zipPath: string; outPath: string }

openZipEntry(zipPath, 'Metadata.xml')
  .then((xml) => buildDatabase(xml, outPath, (games) => parentPort?.postMessage({ type: 'progress', games })))
  .then((result) => parentPort?.postMessage({ type: 'done', games: result.games, images: result.images }))
  .catch((e: Error) => parentPort?.postMessage({ type: 'error', message: e.message }))

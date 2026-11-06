import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { startDaemon } from "./api/server.ts";

const dbPath = process.env.ATM_DB_PATH ?? "./data/atm.db";
const port = Number(process.env.ATM_PORT ?? 3000);
mkdirSync(dirname(dbPath), { recursive: true });
const daemon = await startDaemon({ dbPath, port });
console.log(`Daemon ouvindo em ${daemon.url} (banco: ${dbPath})`);

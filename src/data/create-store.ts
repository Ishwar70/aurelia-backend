import { MongoClient } from "mongodb";
import type { CommerceStore } from "./store";
import { MemoryStore } from "./memory-store";
import { MongoStore } from "./mongo-store";

let singleton: Promise<CommerceStore> | null = null;

export async function createStore(): Promise<CommerceStore> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return MemoryStore.fromSeed();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "aurelia");
  return MongoStore.open(database);
}

export function getStore(): Promise<CommerceStore> {
  if (!singleton) {
    singleton = createStore().catch((error: unknown) => {
      singleton = null;
      throw error;
    });
  }
  return singleton;
}


import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

export interface StoredQuote {
  id: string;
  brief: string;
  createdAt: string;
  messages: StoredMessage[];
  finalSummary?: string;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface QuoteStore {
  version: 1;
  sessions: StoredQuote[];
}

const DEFAULT_STORE_PATH = path.join(os.homedir(), ".quote-cli", "quotes.json");

export function generateSessionId(): string {
  return randomUUID();
}

function getStorePath(): string {
  return DEFAULT_STORE_PATH;
}

async function ensureStoreDir(storePath: string): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });
}

export async function loadQuoteStore(): Promise<QuoteStore> {
  const storePath = getStorePath();
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as QuoteStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      throw new Error("Invalid store format.");
    }
    return parsed;
  } catch (error: any) {
    if (error && error.code === "ENOENT") {
      return { version: 1, sessions: [] };
    }
    throw error;
  }
}

export async function saveQuoteStore(store: QuoteStore): Promise<void> {
  const storePath = getStorePath();
  await ensureStoreDir(storePath);
  const payload = JSON.stringify(store, null, 2);
  await fs.writeFile(storePath, payload, "utf-8");
}

export async function appendQuoteSession(session: StoredQuote): Promise<void> {
  const store = await loadQuoteStore();
  store.sessions.push(session);
  await saveQuoteStore(store);
}

export async function listQuoteSessions(): Promise<StoredQuote[]> {
  const store = await loadQuoteStore();
  return store.sessions;
}

export async function updateQuoteSession(updated: StoredQuote): Promise<void> {
  const store = await loadQuoteStore();
  const index = store.sessions.findIndex((session) => session.id === updated.id);
  if (index >= 0) {
    store.sessions[index] = updated;
  } else {
    store.sessions.push(updated);
  }
  await saveQuoteStore(store);
}

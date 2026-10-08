import type { CheckpointPointer, CollectionReport } from './operations.ts';
import type { EventRecord, Filters } from './types.ts';
import type { SourceQuarantineReason } from '../../contracts/source-evidence.ts';

/** Transport operations deliberately expose documents and objects, never SQL. */
export interface ControlTransaction {
  get<T>(path: string): Promise<T | null>;
  set(path: string, data: Record<string, unknown>): void;
  delete(path: string): void;
}
export interface ControlStore {
  get<T>(path: string): Promise<T | null>;
  list<T>(collection: string): Promise<{ id: string; data: T }[]>;
  transaction<T>(callback: (tx: ControlTransaction) => Promise<T>): Promise<T>;
}
export interface BlobStore {
  get(key: string): Promise<{ body: string; bytes: number } | null>;
  putImmutable(key: string, body: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
export interface Lease {
  key: string;
  token: string;
  expiresAt: number;
}
export interface SourcePage {
  url: string;
  events: EventRecord[];
  /** A source-verified empty inventory; never inferred from an extraction failure. */
  retiredAt?: string;
  /** A source page withheld because its sessions conflict with authoritative source evidence. */
  quarantinedAt?: string;
  quarantineReason?: SourceQuarantineReason;
}
export interface VectorEntry {
  hash: string;
  vector: number[];
}
export interface CatalogStatus {
  status: 'ready' | 'stale' | 'empty';
  stored: number;
  eligible: number;
  lastCheckedAt: string | null;
  oldestCheckedAt: string | null;
  expiresAt: string | null;
}
export interface PublishedState {
  catalog: CatalogStatus;
  checkpoint: CheckpointPointer | null;
  search?: {
    pending: boolean;
    checkpoint: CheckpointPointer | null;
    sourceCatalog: CatalogStatus;
  };
}
export interface HighLevelStore {
  health(): Promise<void>;
  /** Canonical sessions with provider offers; recommendation must not re-merge. */
  candidates(filters: Filters, now?: Date): Promise<EventRecord[]>;
  /** Prepared current and future document variants, including pending publication. */
  embeddingCandidates(now?: Date): Promise<EventRecord[]>;
  /** Atomically expose prepared search only once its exact profile is fully indexed. */
  activateSearchCatalog(profile: string, lease: Lease): Promise<{ activated: boolean; pending: number }>;
  catalogStatus(now?: Date): Promise<CatalogStatus>;
  consumeLimit(key: string, limit: number, expiresAt: number): Promise<boolean>;
  acquireLease(key: string, ttlMs?: number): Promise<Lease | null>;
  releaseLease(lease: Lease): Promise<void>;
  importPages(
    pages: SourcePage[],
    lease: Lease,
  ): Promise<{ imported: number; skipped: number }>;
  checkpointPointer(): Promise<CheckpointPointer | null>;
  readCheckpoint(): Promise<string | null>;
  publishCheckpoint(
    report: CollectionReport,
    lease: Lease,
  ): Promise<CheckpointPointer>;
  checkpointExists(pointer: CheckpointPointer): Promise<boolean>;
  currentPublished(now?: Date): Promise<PublishedState>;
  voyageVectorsByHash(
    profile: string,
    hashes: string[],
    dimensions: number,
  ): Promise<Map<string, number[]>>;
  saveVoyageVectors(
    profile: string,
    entries: VectorEntry[],
    lease: Lease,
  ): Promise<void>;
}

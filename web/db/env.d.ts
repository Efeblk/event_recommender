declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    COLLECTION_STATE?: R2Bucket;
  }
}

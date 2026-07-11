import { Pool } from "pg";

// single shared pool — Neon's pooled connection string handles server-side pooling
export const db = new Pool({ connectionString: process.env.DATABASE_URL });

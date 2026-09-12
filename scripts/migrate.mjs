#!/usr/bin/env node
/**
 * Apply db/migrations/*.sql in filename order, once each.
 * Usage: DATABASE_URL=postgres://... npm run db:migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Nothing to migrate.');
  process.exit(1);
}

const dir = path.resolve('db/migrations');
const client = new pg.Client({ connectionString });
await client.connect();

await client.query(`
  create table if not exists schema_migrations (
    name       text primary key,
    applied_at timestamptz not null default now()
  )
`);

const applied = new Set(
  (await client.query('select name from schema_migrations')).rows.map((row) => row.name),
);

const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
let count = 0;

for (const name of files) {
  if (applied.has(name)) continue;
  const sql = await readFile(path.join(dir, name), 'utf8');
  process.stdout.write(`applying ${name} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into schema_migrations (name) values ($1)', [name]);
    await client.query('commit');
    console.log('ok');
    count++;
  } catch (error) {
    await client.query('rollback');
    console.log('failed');
    console.error(error);
    await client.end();
    process.exit(1);
  }
}

console.log(count === 0 ? 'Already up to date.' : `Applied ${count} migration(s).`);
await client.end();

import type { NativeArtifacts } from './wrgit/native-artifacts.ts';

export type Value = string | number | null;
export interface Rows<T> { results: T[]; success: boolean }
export interface Statement {
  bind(...args: Value[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<Rows<T>>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch<T>(statements: Statement[]): Promise<Rows<T>[]>;
}
export interface Env { DB: Database; FILES?: import('./files.ts').FileBucket; FILE_MAX_BYTES?: string; FILE_TTL_SECONDS?: string; FILE_HOUR_BYTES?: string; FILE_ROOM_MAX_BYTES?: string; WRGIT_ENABLED?: string; ARTIFACTS?: NativeArtifacts }

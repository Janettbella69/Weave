import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const documents = sqliteTable("weave_documents", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  document: text("document").notNull(),
});
export const commits = sqliteTable("weave_commits", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  token: text("token").notNull().default(""),
});

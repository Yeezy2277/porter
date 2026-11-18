-- pgvector must exist before the vector column; Neon and PGlite both ship it.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "entities" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"name" text NOT NULL,
	"text" text NOT NULL,
	"search_text" text NOT NULL,
	"embedder" text NOT NULL,
	"embedding" vector(512) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links" (
	"source_key" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"decision" text NOT NULL,
	"entry_id" text,
	"decided_by" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vector_used" integer DEFAULT 1 NOT NULL,
	"call_id" integer,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_call_id_llm_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entities_embedding_hnsw" ON "entities" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "entities_search_gin" ON "entities" USING gin (to_tsvector('english', "search_text"));
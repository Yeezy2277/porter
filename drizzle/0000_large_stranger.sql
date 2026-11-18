CREATE TABLE "llm_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_key" text NOT NULL,
	"model" text NOT NULL,
	"mode" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint NOT NULL,
	"duration_ms" integer NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mappings" (
	"content_type" text PRIMARY KEY NOT NULL,
	"mapping" jsonb NOT NULL,
	"status" text NOT NULL,
	"proposed_by" integer,
	"edited" integer DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mappings" ADD CONSTRAINT "mappings_proposed_by_llm_calls_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;
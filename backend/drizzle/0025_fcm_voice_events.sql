CREATE TABLE "voice_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"platform" text,
	"at" timestamp with time zone NOT NULL,
	"step" text NOT NULL,
	"detail" text,
	"state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_tokens" ADD COLUMN "fcm_token" text;--> statement-breakpoint
ALTER TABLE "voice_events" ADD CONSTRAINT "voice_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_events_user_at_idx" ON "voice_events" USING btree ("user_id","at");--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_fcm_token_unique" UNIQUE("fcm_token");
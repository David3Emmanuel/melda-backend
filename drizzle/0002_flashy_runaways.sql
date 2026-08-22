ALTER TABLE "classes" ADD COLUMN "invite_code" text;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_invite_code_unique" UNIQUE("invite_code");
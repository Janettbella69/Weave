CREATE TABLE `weave_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`token` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `weave_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`document` text NOT NULL
);

CREATE TABLE `embeddings` (
	`event_id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`model` text NOT NULL,
	`vector` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`starts_at` text NOT NULL,
	`checked_at` text NOT NULL,
	`category` text NOT NULL,
	`price` real,
	`source_url` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_starts_at` ON `events` (`starts_at`);--> statement-breakpoint
CREATE INDEX `idx_events_source_url` ON `events` (`source_url`);--> statement-breakpoint
CREATE TABLE `request_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);

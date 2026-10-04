CREATE TABLE translation_jobs (
 id uuid PRIMARY KEY,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','partial','failed')),
 languages jsonb NOT NULL,
 glossary jsonb NOT NULL DEFAULT '[]',
 fake_scenario text NOT NULL DEFAULT 'normal',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE translation_results (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES translation_jobs(id),
 source_key text NOT NULL,
 source_text text NOT NULL,
 language text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
 target_text text,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 error_code text,
 human_edited boolean NOT NULL DEFAULT false,
 approved boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (job_id, source_key, language),
 CHECK (NOT approved OR (status = 'succeeded' AND target_text IS NOT NULL))
);
CREATE INDEX pending_results ON translation_results (job_id, status);
CREATE TABLE translation_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 result_id uuid NOT NULL REFERENCES translation_results(id),
 attempt integer NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('succeeded','failed','discarded')),
 error_code text,
 duration_ms integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
